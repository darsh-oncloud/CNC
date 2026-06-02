/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/file', 'N/record', 'N/search', 'N/log', 'N/email', 'N/runtime'], function(file, record, search, log, email, runtime) {

    var PENDING_FOLDER = 37467318;
    var PROCESSED_FOLDER = 37467319;
    var ERROR_FOLDER = 37467320;

    var LOCATION_ID = 7;
    var PLACEHOLDER_ITEM = 306263;
    var PLACEHOLDER_RATE = 10;

    // ===== EMAIL SETUP =====
    var AUTHOR_ID = 144846;
    var RECIPIENTS = [104977];

    function getInputData() {
        var arr = [];
        search.create({
            type: 'file',
            filters: [['folder', 'anyof', PENDING_FOLDER]],
            columns: ['internalid']
        }).run().each(function(r) {
            arr.push(r.getValue({ name: 'internalid' }));
            return true;
        });
        return arr;
    }

    function map(context) {
        context.write({
            key: context.value,
            value: context.value
        });
    }

    function reduce(context) {
        try {
            var fileId = context.key;
            var csvFile = file.load({ id: fileId });
            var originalCsv = csvFile.getContents();
            var parsed = parseCSV(originalCsv);
            var headers = parsed.headers;
            var data = parsed.data;
            var i;

            if (!data.length) {
                log.error('Reduce Error', 'No data found in file ' + fileId);
                return;
            }

            var poKey        = getHeaderKey(headers, 'Purchase Order');
            var companyKey   = getHeaderKey(headers, 'Company');
            var companyNoKey = getHeaderKey(headers, 'Company Number');
            var itemKey      = getHeaderKey(headers, 'Supplier Product Code');
            var addrKey      = getHeaderKey(headers, 'Address1');
            var addr2Key     = getHeaderKey(headers, 'Address2');
            var cityKey      = getHeaderKey(headers, 'City');
            var stateKey     = getHeaderKey(headers, 'State');
            var zipKey       = getHeaderKey(headers, 'Zip');
            var countryKey   = getHeaderKey(headers, 'Country');
            var qtyKey       = getHeaderKey(headers, 'Quantity');

            if (!poKey || !companyKey || !companyNoKey || !itemKey || !addrKey || !qtyKey) {
                log.error('Reduce Error', 'Required header missing in file ' + fileId);
                return;
            }

            var firstRow = data[0];
            var poNumber = String(firstRow[poKey] || '').trim();
            var companyNameFromFile = String(firstRow[companyKey] || '').trim();
            var companyNumberFromFile = String(firstRow[companyNoKey] || '').trim();
            var finalPoNumber = '';

            if (!poNumber) {
                log.error('Reduce Error', 'Purchase Order is missing in file ' + fileId);
                return;
            }

            if (!companyNameFromFile) {
                log.error('Reduce Error', 'Company is missing in file ' + fileId);
                return;
            }

            if (!companyNumberFromFile) {
                markAllRowsError(data, 'Company Number is missing');
                var errorFileId1 = createErrorFile(csvFile.name, headers, data, '');
                context.write({
                    key: 'ERROR_EMAIL',
                    value: JSON.stringify({
                        errorFileId: errorFileId1,
                        errorFileName: csvFile.name
                    })
                });
                file.delete({ id: fileId });
                log.error('Reduce Error', 'Company Number is missing in file ' + fileId);
                return;
            }

            finalPoNumber = companyNumberFromFile + ' - ' + poNumber;

            var existingSoId = findExistingSalesOrderByPO(finalPoNumber);
            if (existingSoId) {
                markAllRowsError(data, 'Sales Order already exists with same PO Number: ' + finalPoNumber);
                var errorFileId2 = createErrorFile(csvFile.name, headers, data, existingSoId);
                context.write({
                    key: 'ERROR_EMAIL',
                    value: JSON.stringify({
                        errorFileId: errorFileId2,
                        errorFileName: csvFile.name
                    })
                });
                file.delete({ id: fileId });
                log.error('Duplicate PO', 'Sales Order already exists for PO ' + finalPoNumber + ' | Existing SO ID: ' + existingSoId);
                return;
            }

            var customerId = findCustomerByCompanyNumber(companyNumberFromFile);
            if (!customerId) {
                markAllRowsError(data, 'Customer not found for Company Number: ' + companyNumberFromFile);
                var errorFileId3 = createErrorFile(csvFile.name, headers, data, '');
                context.write({
                    key: 'ERROR_EMAIL',
                    value: JSON.stringify({
                        errorFileId: errorFileId3,
                        errorFileName: csvFile.name
                    })
                });
                file.delete({ id: fileId });
                log.error('Customer Not Found', 'Company: ' + companyNameFromFile + ' | Company Number: ' + companyNumberFromFile);
                return;
            }

            var so = record.create({
                type: record.Type.SALES_ORDER,
                isDynamic: true
            });

            so.setValue({ fieldId: 'entity', value: customerId });
            so.setValue({ fieldId: 'location', value: LOCATION_ID });
            so.setValue({ fieldId: 'otherrefnum', value: finalPoNumber });

            setShippingAddressFromCustomerOrCSV(so, customerId, firstRow, {
                addrKey: addrKey,
                addr2Key: addr2Key,
                cityKey: cityKey,
                stateKey: stateKey,
                zipKey: zipKey,
                countryKey: countryKey
            });

            var addedLines = 0;
            var hasError = false;

            for (i = 0; i < data.length; i++) {
                var rowObj = data[i];
                var supplierCode = String(rowObj[itemKey] || '').trim();
                var qty = parseFloat(rowObj[qtyKey] || 0);
                var itemId = '';

                if (!qty || qty <= 0) {
                    rowObj.Error = 'Invalid quantity';
                    hasError = true;
                    continue;
                }

                itemId = findItemByCode(supplierCode);

                so.selectNewLine({ sublistId: 'item' });

                if (itemId) {
                    so.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        value: itemId
                    });
                } else {
                    so.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        value: PLACEHOLDER_ITEM
                    });
                    so.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'rate',
                        value: PLACEHOLDER_RATE
                    });
                    rowObj.Error = 'Item not found: ' + supplierCode;
                    hasError = true;
                }

                so.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_boomi_edi_item_name',
                    value: supplierCode
                });

                so.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    value: qty
                });

                so.commitLine({ sublistId: 'item' });
                addedLines++;
            }

            if (!addedLines) {
                log.error('Reduce Error', 'No valid lines to create SO for file ' + fileId);
                return;
            }

            var soId = so.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            var newFileId = '';
            if (hasError) {
                for (i = 0; i < data.length; i++) {
                    data[i]['Sales Order Internal ID'] = soId || '';
                    if (!data[i].Error) data[i].Error = '';
                }
                newFileId = createErrorFile(csvFile.name, headers, data, soId || '');
                context.write({
                    key: 'ERROR_EMAIL',
                    value: JSON.stringify({
                        errorFileId: newFileId,
                        errorFileName: csvFile.name
                    })
                });
            } else {
                newFileId = file.create({
                    name: csvFile.name,
                    fileType: file.Type.CSV,
                    contents: originalCsv,
                    folder: PROCESSED_FOLDER
                }).save();
            }

            file.delete({ id: fileId });
            log.audit('Sales Order Created', 'SO ID: ' + soId + ' | File ID: ' + newFileId);

        } catch (e) {
            log.error('Reduce Error', e.name + ' : ' + e.message);
        }
    }

    function summarize(summary) {
        try {
            var errorFiles = [];
            var seen = {};

            summary.output.iterator().each(function(key, value) {
                if (key === 'ERROR_EMAIL') {
                    try {
                        var obj = JSON.parse(value);
                        if (obj && obj.errorFileId && !seen[obj.errorFileId]) {
                            seen[obj.errorFileId] = true;
                            errorFiles.push(obj);
                        }
                    } catch (e) {
                        log.error('summarize parse error', e.name + ' : ' + e.message);
                    }
                }
                return true;
            });

            if (!errorFiles.length) {
                log.audit('summarize', 'No error files created in this run. No email sent.');
                return;
            }

            sendConsolidatedErrorEmail(errorFiles);

        } catch (e) {
            log.error('summarize Error', e.name + ' : ' + e.message);
        }
    }

    function findExistingSalesOrderByPO(poNumber) {
        var soId = '';

        search.create({
            type: 'salesorder',
            filters: [
                ['type', 'anyof', 'SalesOrd'],
                'AND',
                ['otherrefnum', 'equalto', String(poNumber).trim()],
                'AND',
                ['mainline', 'is', 'T']
            ],
            columns: [
                search.createColumn({ name: 'internalid', label: 'Internal ID' })
            ]
        }).run().each(function(result) {
            soId = result.getValue({ name: 'internalid' });
            return false;
        });

        return soId;
    }

    function findCustomerByCompanyNumber(companyNumberFromFile) {
        var customerIds = [];
        var companyNumber = String(companyNumberFromFile || '').replace(/[^0-9]/g, '').trim();

        if (!companyNumber) return '';

        search.create({
            type: search.Type.CUSTOMER,
            filters: [
                ['isinactive', 'is', 'F'],
                'AND',
                [
                    ['companyname', 'contains', companyNumber],
                    'OR',
                    ['entityid', 'contains', companyNumber]
                ]
            ],
            columns: [
                search.createColumn({ name: 'internalid', sort: search.Sort.ASC })
            ]
        }).run().each(function(r) {
            customerIds.push(r.getValue({ name: 'internalid' }));
            if (customerIds.length > 1) {
                return false;
            }
            return true;
        });

        if (customerIds.length === 1) {
            return customerIds[0];
        }

        return '';
    }

    function findItemByCode(supplierCode) {
        var itemId = '';
        if (!supplierCode) return '';

        itemId = getItemInternalId(supplierCode);
        if (!itemId && /[LR]$/i.test(supplierCode)) {
            itemId = getItemInternalId(supplierCode.replace(/[LR]$/i, ''));
        }
        return itemId;
    }

    function getItemInternalId(itemCode) {
        var itemId = '';
        search.create({
            type: search.Type.ITEM,
            filters: [['itemid', 'is', itemCode]],
            columns: [
                search.createColumn({
                    name: 'internalid',
                    sort: search.Sort.ASC
                })
            ]
        }).run().each(function(r) {
            itemId = r.getValue({ name: 'internalid' });
            return false;
        });
        return itemId;
    }

    function setShippingAddressFromCustomerOrCSV(so, customerId, firstRow, keys) {
        var customerRec = record.load({
            type: record.Type.CUSTOMER,
            id: customerId
        });

        var csvAddr1 = normalizeAddress(firstRow[keys.addrKey] || '');
        var addressCount = customerRec.getLineCount({ sublistId: 'addressbook' });
        var a, addrSubrec, addrLine, addrInternalId;

        for (a = 0; a < addressCount; a++) {
            addrSubrec = customerRec.getSublistSubrecord({
                sublistId: 'addressbook',
                fieldId: 'addressbookaddress',
                line: a
            });

            addrLine = normalizeAddress(addrSubrec.getValue({ fieldId: 'addr1' }) || '');
            if (addrLine === csvAddr1 || addrLine.indexOf(csvAddr1) !== -1 || csvAddr1.indexOf(addrLine) !== -1) {
                addrInternalId = customerRec.getSublistValue({
                    sublistId: 'addressbook',
                    fieldId: 'id',
                    line: a
                });

                if (addrInternalId) {
                    so.setValue({
                        fieldId: 'shipaddresslist',
                        value: addrInternalId
                    });
                    return;
                }
            }
        }

        var shipSubrec = so.getSubrecord({ fieldId: 'shippingaddress' });
        shipSubrec.setValue({ fieldId: 'addr1', value: firstRow[keys.addrKey] || '' });
        if (keys.addr2Key) shipSubrec.setValue({ fieldId: 'addr2', value: firstRow[keys.addr2Key] || '' });
        if (keys.cityKey) shipSubrec.setValue({ fieldId: 'city', value: firstRow[keys.cityKey] || '' });
        if (keys.stateKey) shipSubrec.setValue({ fieldId: 'state', value: firstRow[keys.stateKey] || '' });
        if (keys.zipKey) shipSubrec.setValue({ fieldId: 'zip', value: firstRow[keys.zipKey] || '' });
        shipSubrec.setValue({
            fieldId: 'country',
            value: keys.countryKey ? (firstRow[keys.countryKey] || 'US') : 'US'
        });
    }

    function markAllRowsError(data, message) {
        for (var i = 0; i < data.length; i++) {
            data[i].Error = message;
        }
    }

    function createErrorFile(fileName, headers, data, soId) {
        var errorHeaders = headers.slice(0);
        var i;

        if (errorHeaders.indexOf('Error') === -1) errorHeaders.push('Error');
        if (errorHeaders.indexOf('Sales Order Internal ID') === -1) errorHeaders.push('Sales Order Internal ID');

        for (i = 0; i < data.length; i++) {
            data[i]['Sales Order Internal ID'] = soId || '';
            if (!data[i].Error) data[i].Error = '';
        }

        return file.create({
            name: fileName,
            fileType: file.Type.CSV,
            contents: buildCsv(errorHeaders, data),
            folder: ERROR_FOLDER
        }).save();
    }

    function sendConsolidatedErrorEmail(errorFiles) {
        try {
            var env = runtime.envType || 'PRODUCTION';
            var accountId = (runtime.accountId || '').toLowerCase().replace('_', '-');
            var html = '';
            var i, recordUrl;

            html += '<html><body>';
            html += '<p>Hello,</p>';
            html += '<p>Error files were generated while processing the Sales Order import in ' + env + '.</p>';
            html += '<p><b>Total error files:</b> ' + errorFiles.length + '</p>';
            html += '<p>The following files need review:</p>';
            html += '<ul>';

            for (i = 0; i < errorFiles.length; i++) {
                recordUrl = 'https://' + accountId + '.app.netsuite.com/app/common/media/mediaitem.nl?id=' + errorFiles[i].errorFileId;
                html += '<li><a href="' + recordUrl + '">' + errorFiles[i].errorFileName + '</a></li>';
            }

            html += '</ul>';
            html += '<p><b>Your attention is needed.</b></p>';
            html += '<p>Thanks<br/>NetSuite ERP Admin</p>';
            html += '</body></html>';

            email.send({
                author: AUTHOR_ID,
                recipients: RECIPIENTS,
                subject: 'Alert: ECBARTON Sales Order File Processing Failed – [' + errorFiles.length + ' Error File(s)]',
                body: html
            });

            log.audit('Consolidated Error Email Sent', {
                author: AUTHOR_ID,
                recipients: RECIPIENTS,
                errorFileCount: errorFiles.length
            });

        } catch (e) {
            log.error('sendConsolidatedErrorEmail Error', e.name + ' : ' + e.message);
        }
    }

    function getHeaderKey(headers, label) {
        var cleanLabel = cleanText(label), i;
        for (i = 0; i < headers.length; i++) {
            if (cleanText(headers[i]) === cleanLabel) return headers[i];
        }
        return '';
    }

    function cleanText(s) {
        return String(s || '').replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function normalizeAddress(s) {
        s = String(s || '').toLowerCase();
        s = s.replace(/\./g, '');
        s = s.replace(/\beast\b/g, 'e');
        s = s.replace(/\bwest\b/g, 'w');
        s = s.replace(/\bnorth\b/g, 'n');
        s = s.replace(/\bsouth\b/g, 's');
        s = s.replace(/\s+/g, ' ').trim();
        return s;
    }

    function parseCSV(csv) {
        var lines = csv.split(/\r?\n/);
        var headers = [];
        var data = [];
        var i, j, cols, row;

        for (i = 0; i < lines.length; i++) {
            if (!lines[i] || !lines[i].trim()) continue;

            cols = splitCsvLine(lines[i]);
            for (j = 0; j < cols.length; j++) {
                cols[j] = String(cols[j] || '').trim();
            }

            if (!headers.length) {
                headers = cols;
                continue;
            }

            row = {};
            for (j = 0; j < headers.length; j++) {
                row[headers[j]] = cols[j] || '';
            }
            data.push(row);
        }

        return { headers: headers, data: data };
    }

    function splitCsvLine(line) {
        var result = [];
        var current = '';
        var inQuotes = false;
        var i, c, nextChar;

        for (i = 0; i < line.length; i++) {
            c = line.charAt(i);
            nextChar = line.charAt(i + 1);

            if (c === '"') {
                if (inQuotes && nextChar === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (c === ',' && !inQuotes) {
                result.push(current);
                current = '';
            } else {
                current += c;
            }
        }

        result.push(current);
        return result;
    }

    function buildCsv(headers, data) {
        var out = buildCsvLine(headers) + '\n';
        var i, j, row;

        for (i = 0; i < data.length; i++) {
            row = [];
            for (j = 0; j < headers.length; j++) {
                row.push(data[i][headers[j]] || '');
            }
            out += buildCsvLine(row) + '\n';
        }
        return out;
    }

    function buildCsvLine(arr) {
        var out = [];
        for (var i = 0; i < arr.length; i++) {
            out.push('"' + String(arr[i] || '').replace(/"/g, '""') + '"');
        }
        return out.join(',');
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});