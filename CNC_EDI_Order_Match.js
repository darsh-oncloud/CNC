/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/file', 'N/record', 'N/log'], (file, record, log) => {

    // ==============================
    // UPDATE THESE VALUES ONLY
    // ==============================
    const EDI_FILE_ID = 'PUT_EDI_FILE_INTERNAL_ID_HERE';
    const SALES_ORDER_ID = 'PUT_SALES_ORDER_INTERNAL_ID_HERE';

    // Output folder where CSV will be created
    const OUTPUT_FOLDER_ID = 37467320;

    // SO line field which stores EDI item code like F330, DB27, etc.
    const SO_EDI_ITEM_FIELD = 'custcolproductserviceid_po107';

    // Keep 0 unless SO line rate is already discounted
    const DISCOUNT_PERCENT = 0;

    // ==============================

    const getInputData = () => {
        return [{
            ediFileId: EDI_FILE_ID,
            salesOrderId: SALES_ORDER_ID
        }];
    };

    const map = (context) => {
        const input = JSON.parse(context.value);

        const ediFile = file.load({
            id: input.ediFileId
        });

        const ediContent = ediFile.getContents();

        const parsedEdi = parseEdi850(ediContent);
        const ediLines = parsedEdi.lines;

        log.audit('EDI Parsed', {
            poNumber: parsedEdi.header.poNumber,
            ediLineCount: ediLines.length
        });

        const soRec = record.load({
            type: record.Type.SALES_ORDER,
            id: input.salesOrderId,
            isDynamic: false
        });

        const soLines = getSalesOrderLines(soRec);

        log.audit('SO Parsed', {
            salesOrderId: input.salesOrderId,
            soLineCount: soLines.length
        });

        const results = matchLines(ediLines, soLines);

        const csv = buildCsv(parsedEdi.header, input.salesOrderId, results);

        const outputFile = file.create({
            name: 'EDI_SO_MATCH_' + input.salesOrderId + '_' + new Date().getTime() + '.csv',
            fileType: file.Type.CSV,
            contents: csv,
            folder: OUTPUT_FOLDER_ID
        });

        const outputFileId = outputFile.save();

        log.audit('CSV Created', {
            outputFileId: outputFileId,
            folderId: OUTPUT_FOLDER_ID
        });
    };

    function parseEdi850(content) {
        const cleanContent = String(content || '')
            .replace(/\r/g, '')
            .replace(/\n/g, '');

        const segments = cleanContent
            .split('~')
            .map(s => s.trim())
            .filter(Boolean);

        const header = {
            poNumber: '',
            poDate: '',
            requestedDate: '',
            currency: '',
            discountNote: ''
        };

        const lines = [];
        let currentLine = null;

        segments.forEach(segment => {
            const parts = segment.split('*');
            const tag = parts[0];

            if (tag === 'BEG') {
                header.poNumber = parts[3] || '';
                header.poDate = parts[5] || '';
            }

            if (tag === 'CUR') {
                header.currency = parts[2] || '';
            }

            if (tag === 'DTM' && parts[1] === '002') {
                header.requestedDate = parts[2] || '';
            }

            if (tag === 'MTX') {
                header.discountNote = parts[2] || '';
            }

            if (tag === 'PO1') {
                if (currentLine) {
                    currentLine.description = currentLine.descriptions.join(' | ');
                    currentLine.note = currentLine.notes.join(' | ');
                    lines.push(currentLine);
                }

                const ediLineNo = parts[1] || '';
                const qty = toNumber(parts[2]);
                const uom = parts[3] || '';
                const rate = toNumber(parts[4]);

                let ediItem = '';
                let customerSku = '';

                for (let i = 6; i < parts.length; i += 2) {
                    const qualifier = parts[i];
                    const value = parts[i + 1] || '';

                    if (qualifier === 'VP') {
                        ediItem = value;
                    }

                    if (qualifier === 'SK') {
                        customerSku = value;
                    }
                }

                const compareRate = applyDiscount(rate);

                currentLine = {
                    ediLineNo: ediLineNo,
                    ediItem: ediItem,
                    customerSku: customerSku,
                    qty: qty,
                    uom: uom,
                    rate: rate,
                    compareRate: compareRate,
                    amount: round2(qty * rate),
                    compareAmount: round2(qty * compareRate),
                    descriptions: [],
                    notes: [],
                    description: '',
                    note: ''
                };
            }

            if (tag === 'PID' && currentLine) {
                const pidType = parts[2] || '';
                const desc = parts[5] || '';

                if (desc) {
                    if (pidType === 'ZZ') {
                        currentLine.notes.push(desc);
                    } else {
                        currentLine.descriptions.push(desc);
                    }
                }
            }
        });

        if (currentLine) {
            currentLine.description = currentLine.descriptions.join(' | ');
            currentLine.note = currentLine.notes.join(' | ');
            lines.push(currentLine);
        }

        return {
            header: header,
            lines: lines
        };
    }

    function getSalesOrderLines(soRec) {
        const lines = [];
        const count = soRec.getLineCount({
            sublistId: 'item'
        });

        for (let i = 0; i < count; i++) {
            const ediItemValue = getSublistValueSafe(soRec, 'item', SO_EDI_ITEM_FIELD, i);

            const itemId = getSublistValueSafe(soRec, 'item', 'item', i);
            const itemText = getSublistTextSafe(soRec, 'item', 'item', i);

            const qty = toNumber(getSublistValueSafe(soRec, 'item', 'quantity', i));
            const rate = toNumber(getSublistValueSafe(soRec, 'item', 'rate', i));
            const amount = toNumber(getSublistValueSafe(soRec, 'item', 'amount', i));

            const lineId = getSublistValueSafe(soRec, 'item', 'line', i);
            const lineUniqueKey = getSublistValueSafe(soRec, 'item', 'lineuniquekey', i);

            lines.push({
                index: i,
                lineId: lineId,
                lineUniqueKey: lineUniqueKey,
                itemId: itemId,
                itemText: itemText,
                ediItemValue: ediItemValue,
                qty: qty,
                rate: rate,
                amount: amount,
                used: false
            });
        }

        return lines;
    }

    function matchLines(ediLines, soLines) {
        const output = [];

        ediLines.forEach(ediLine => {
            const matchedSoLine = findBestSoMatch(ediLine, soLines);

            if (!matchedSoLine) {
                output.push({
                    type: 'EDI_LINE',
                    status: 'NOT_FOUND_IN_SO',
                    reason: 'No SO line found with same ' + SO_EDI_ITEM_FIELD,
                    edi: ediLine,
                    so: null,
                    qtyMatch: 'No',
                    rateMatch: 'No',
                    amountMatch: 'No',
                    qtyDiff: '',
                    rateDiff: '',
                    amountDiff: ''
                });
                return;
            }

            matchedSoLine.used = true;

            const qtyMatch = isSameNumber(ediLine.qty, matchedSoLine.qty);
            const rateMatch = isSameNumber(ediLine.compareRate, matchedSoLine.rate);
            const amountMatch = isSameNumber(ediLine.compareAmount, matchedSoLine.amount);

            let status = 'MATCHED_EXACT';
            const reasons = [];

            if (!qtyMatch) {
                status = 'MATCHED_WITH_DIFFERENCE';
                reasons.push('Qty mismatch');
            }

            if (!rateMatch) {
                status = 'MATCHED_WITH_DIFFERENCE';
                reasons.push('Rate mismatch');
            }

            if (!amountMatch) {
                status = 'MATCHED_WITH_DIFFERENCE';
                reasons.push('Amount mismatch');
            }

            output.push({
                type: 'EDI_LINE',
                status: status,
                reason: reasons.length ? reasons.join(', ') : 'EDI line matched SO line',
                edi: ediLine,
                so: matchedSoLine,
                qtyMatch: qtyMatch ? 'Yes' : 'No',
                rateMatch: rateMatch ? 'Yes' : 'No',
                amountMatch: amountMatch ? 'Yes' : 'No',
                qtyDiff: round2(matchedSoLine.qty - ediLine.qty),
                rateDiff: round2(matchedSoLine.rate - ediLine.compareRate),
                amountDiff: round2(matchedSoLine.amount - ediLine.compareAmount)
            });
        });

        soLines.forEach(soLine => {
            if (!soLine.used) {
                output.push({
                    type: 'SO_EXTRA_LINE',
                    status: 'EXTRA_SO_LINE_NOT_IN_EDI',
                    reason: 'SO line was not matched to any EDI PO1 line',
                    edi: null,
                    so: soLine,
                    qtyMatch: '',
                    rateMatch: '',
                    amountMatch: '',
                    qtyDiff: '',
                    rateDiff: '',
                    amountDiff: ''
                });
            }
        });

        return output;
    }

    function findBestSoMatch(ediLine, soLines) {
        const ediSku = normalizeSku(ediLine.ediItem);

        const availableLines = soLines.filter(soLine => {
            return !soLine.used &&
                normalizeSku(soLine.ediItemValue) === ediSku;
        });

        if (!availableLines.length) {
            return null;
        }

        // Best match 1: item + qty + rate + amount
        let match = availableLines.find(soLine => {
            return isSameNumber(ediLine.qty, soLine.qty) &&
                isSameNumber(ediLine.compareRate, soLine.rate) &&
                isSameNumber(ediLine.compareAmount, soLine.amount);
        });

        if (match) return match;

        // Best match 2: item + qty + rate
        match = availableLines.find(soLine => {
            return isSameNumber(ediLine.qty, soLine.qty) &&
                isSameNumber(ediLine.compareRate, soLine.rate);
        });

        if (match) return match;

        // Best match 3: item + qty
        match = availableLines.find(soLine => {
            return isSameNumber(ediLine.qty, soLine.qty);
        });

        if (match) return match;

        // Best match 4: item + rate
        match = availableLines.find(soLine => {
            return isSameNumber(ediLine.compareRate, soLine.rate);
        });

        if (match) return match;

        // Last option: same item only
        return availableLines[0];
    }

    function buildCsv(header, salesOrderId, rows) {
        const csvRows = [];

        csvRows.push([
            'PO Number',
            'PO Date',
            'Requested Date',
            'Currency',
            'Sales Order Internal ID',
            'Row Type',
            'Status',
            'Reason',
            'EDI Line No',
            'EDI Item',
            'EDI Customer SKU',
            'EDI Qty',
            'EDI Rate',
            'EDI Amount',
            'EDI Description',
            'EDI Note',
            'SO Line Index',
            'SO Line ID',
            'SO Line Unique Key',
            'SO Item Internal ID',
            'SO Item Name',
            'SO EDI Item Field',
            'SO Qty',
            'SO Rate',
            'SO Amount',
            'Qty Match',
            'Rate Match',
            'Amount Match',
            'Qty Difference',
            'Rate Difference',
            'Amount Difference'
        ].map(csvCell).join(','));

        rows.forEach(row => {
            const edi = row.edi || {};
            const so = row.so || {};

            csvRows.push([
                header.poNumber,
                header.poDate,
                header.requestedDate,
                header.currency,
                salesOrderId,
                row.type,
                row.status,
                row.reason,
                edi.ediLineNo || '',
                edi.ediItem || '',
                edi.customerSku || '',
                edi.qty !== undefined ? edi.qty : '',
                edi.rate !== undefined ? edi.rate : '',
                edi.amount !== undefined ? edi.amount : '',
                edi.description || '',
                edi.note || '',
                so.index !== undefined ? so.index + 1 : '',
                so.lineId || '',
                so.lineUniqueKey || '',
                so.itemId || '',
                so.itemText || '',
                so.ediItemValue || '',
                so.qty !== undefined ? so.qty : '',
                so.rate !== undefined ? so.rate : '',
                so.amount !== undefined ? so.amount : '',
                row.qtyMatch,
                row.rateMatch,
                row.amountMatch,
                row.qtyDiff,
                row.rateDiff,
                row.amountDiff
            ].map(csvCell).join(','));
        });

        return csvRows.join('\n');
    }

    function applyDiscount(rate) {
        if (!DISCOUNT_PERCENT || DISCOUNT_PERCENT <= 0) {
            return round2(rate);
        }

        return round2(rate * (1 - DISCOUNT_PERCENT / 100));
    }

    function normalizeSku(value) {
        return String(value || '')
            .trim()
            .toUpperCase();
    }

    function toNumber(value) {
        if (value === null || value === undefined || value === '') {
            return 0;
        }

        const cleaned = String(value)
            .replace(/,/g, '')
            .replace(/\$/g, '')
            .trim();

        const num = parseFloat(cleaned);
        return isNaN(num) ? 0 : num;
    }

    function round2(num) {
        return Math.round((Number(num) || 0) * 100) / 100;
    }

    function isSameNumber(a, b) {
        return Math.abs(round2(a) - round2(b)) <= 0.01;
    }

    function csvCell(value) {
        if (value === null || value === undefined) {
            value = '';
        }

        return '"' + String(value).replace(/"/g, '""') + '"';
    }

    function getSublistValueSafe(rec, sublistId, fieldId, line) {
        try {
            const value = rec.getSublistValue({
                sublistId: sublistId,
                fieldId: fieldId,
                line: line
            });

            return value === null || value === undefined ? '' : value;
        } catch (e) {
            return '';
        }
    }

    function getSublistTextSafe(rec, sublistId, fieldId, line) {
        try {
            const value = rec.getSublistText({
                sublistId: sublistId,
                fieldId: fieldId,
                line: line
            });

            return value === null || value === undefined ? '' : value;
        } catch (e) {
            return '';
        }
    }

    const summarize = (summary) => {
        if (summary.inputSummary.error) {
            log.error('Input Error', summary.inputSummary.error);
        }

        summary.mapSummary.errors.iterator().each((key, error) => {
            log.error('Map Error for key ' + key, error);
            return true;
        });

        log.audit('Script Completed', 'EDI to SO matching CSV process finished.');
    };

    return {
        getInputData,
        map,
        summarize
    };
});
