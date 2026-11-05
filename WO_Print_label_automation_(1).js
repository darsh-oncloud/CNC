/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Work Order label printing (ZPL through RF-SMART / SIT LPC).
 * On WO create (eTail orders only):
 *   1. Read the WO, SO, customer and assembly item
 *   2. Work out the label text (same rules as the CNC BOM Advanced PDF template)
 *   3. Send the data to the SIT LPC template -> ZPL -> Zebra printer
 *
 * Script parameter (create on the script record):
 *   custscript_wo_label_printer  (Integer or List/Record -> SIT LPC printer)
 */
define(['N/record', 'N/search', 'N/runtime', 'N/https', 'N/log'],
function (record, search, runtime, https, log) {

    // ---------- Settings ----------
    var TEMPLATE_ID = 2;   // SIT LPC Template "WO Label - Test Template"
    var PRINTER_PARAM = 'custscript_wo_label_printer';
    var ETAIL_FIELD = 'custbody_celigo_etail_order_id';

    var RESTLET_SCRIPT = 'customscript_sit_lpc_rest_api';
    var RESTLET_DEPLOY = 'customdeploy_sit_lpc_rest_api';

    var STANDARD_COLORS = ['SMOKY GREY (02)', 'MISTY GREY (03)', 'HARVEST (05)', 'WHITE (10)', 'ESPRESSO (11)'];

    // Label layout (203 dpi, 4x4)
    var RIGHT_COL_WIDTH = 242;

    // ---------- Main ----------
    function afterSubmit(context) {

        if (context.type !== context.UserEventType.EDIT) return;

        var woId = context.newRecord.id;

        try {
            var printerId = runtime.getCurrentScript().getParameter({ name: PRINTER_PARAM });
            if (!printerId) {
                log.error('WO Label', 'Printer parameter ' + PRINTER_PARAM + ' is empty');
                return;
            }

            // 1. Should this WO print?
            var soId = context.newRecord.getValue('createdfrom');
            if (!soId) return;

            var so = record.load({ type: record.Type.SALES_ORDER, id: soId });
            var etailId = so.getValue(ETAIL_FIELD);
            if (!etailId || !String(etailId).trim()) return;

            var wo = record.load({ type: record.Type.WORK_ORDER, id: woId });

            // 2. Build the label data
            var labels = buildLabels(wo, so);

            // 3. Send to printer
            var result = sendToPrinter(woId, printerId, labels);

            log.audit('WO Label Print Submitted', {
                woId: woId,
                soId: soId,
                labels: labels.length,
                templateId: TEMPLATE_ID,
                printerId: printerId,
                apiRecord: result.payload && result.payload.apiRecId,
                printLog: result.payload && result.payload.logId
            });

        } catch (e) {
            log.error('WO Label Failed', {
                woId: woId,
                message: e.message,
                stack: e.stack
            });
        }
    }

    // ---------- Label data (same logic as the Advanced PDF template) ----------
    function buildLabels(wo, so) {

        var txt = function (f) { return fieldText(wo, f); };
        var yes = function (f) { return isTrue(wo.getValue(f)); };

        // Customer + assembly item fields
        var entityId = wo.getValue('entity');
        var cust = entityId ? search.lookupFields({
            type: search.Type.CUSTOMER,
            id: entityId,
            columns: ['custentity9', 'custentity_yy_cu_productioninstr']
        }) : {};

        var asmId = wo.getValue('assemblyitem');
        var asm = asmId ? search.lookupFields({
            type: search.Type.ITEM,
            id: asmId,
            columns: ['custitem_yy_it_uomitem']
        }) : {};

        // Basic values
        var location = txt('location');
        var soTranid = String(so.getValue('tranid') || '');
        var soLocation = fieldText(so, 'location');
        var customer = txt('entity');
        var assembly = txt('assemblyitem');
        var color = txt('custbodymb_wo_color');
        var collection = txt('custbody_mb_collection');

        var isStock = txt('custbody_mb_so_name_wo').toLowerCase().indexOf('stock') !== -1 || !soTranid;
        var isTest = customer === 'YITZ' || Number(entityId) === 75380;
        var pleaseInspect = yes('custbody_mb_wo_please_inspect');
        var isRma = yes('custbody_yy_wo_rmaorder');
        var isRushAddOn = txt('custbody_mb_wo_add_on_accesories').indexOf('Yes') !== -1;
        var isManagerRush = txt('custbody_mb_so_rush_order').indexOf('Rush Order') !== -1;
        var isCountertop = yes('custbody_mb_wo_is_countertop');
        var newCustomer = !!lookupText(cust.custentity9).trim();
        var productionInstr = lookupText(cust.custentity_yy_cu_productioninstr);
        var customColor = txt('custbody51');
        var mfgNotes = txt('custbody_yy_wo_item_mfgnotes');
        var woNotes = txt('custbody_yy_wo_notes');
        var uom = txt('custbody_mb_wo_uom');
        var showUom = isTrue(asm.custitem_yy_it_uomitem) && !!uom;
        var options = txt('options');
        var modifications = txt('custbody_yy_wo_options_nocolor') + txt('custbody_yy_wo_options_nocolor2');

        var plainNjAccessory =
            txt('custbody_mb_wo_inventory_type') === 'ACCESSORY' &&
            location === 'New Jersey' &&
            txt('custbody_mb_group') !== 'HARDWARE' &&
            !pleaseInspect &&
            !options &&
            (collection === 'LUXOR' || collection === 'ACCESSORY') &&
            STANDARD_COLORS.indexOf(color) !== -1;

        // Copies: one label per unit
        var qty = Number(wo.getValue('quantity')) || 0;
        var copies = qty > 0 ? qty : 1;
        var perUnit = qty > 0 ? qty : 1;

        // ----- Header -----
        var title = isTest ? 'TEST ORDER' : assembly;
        if (yes('custbody_yy_nfp') && collection === 'LUXOR') title += '   NFP';

        var subtitle = customColor || color.split(' (')[0];
        if (newCustomer) subtitle += ' -- New Customer';
        if (pleaseInspect) subtitle += ' -- PLEASE INSPECT';

        // ----- Components -----
        var components = [];
        var lines = wo.getLineCount({ sublistId: 'item' });
        for (var i = 0; i < lines; i++) {
            var itemName = wo.getSublistText({ sublistId: 'item', fieldId: 'item', line: i });
            var lineQty = Number(wo.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i })) || 0;
            var lineFul = Number(safeSublistValue(wo, 'quantityfulfilled', i)) || 0;

            if (!itemName) continue;
            if (isRma && lineQty === 0) continue;

            var bc = fitBarcode(itemName, 520, 120);
            components.push({
                qty: clean(fmt((lineQty - lineFul) / perUnit)),
                item: clean(itemName),
                x: String(bc.x),
                by: String(bc.by)
            });
        }

        // ----- Right column rows -----
        var rows = [];
        var ship = '';
        if (location === 'New Jersey' && soLocation !== 'New Jersey') ship = soLocation + ' - ';
        ship += fieldText(so, 'shipmethod') + ' ' + fieldText(so, 'custbody_yy_so_trucklist');
        addRow(rows, ship, 22);
        addRow(rows, 'Prod Date: ' + txt('custbody_mb_production_date'), 24);

        if (isCountertop) {
            if (soTranid) addRow(rows, 'SO#: ' + soTranid, 28);
            addRow(rows, 'PO#: ' + txt('custbody_mb_customer_po'), 28);
            addRow(rows, 'Customer: ' + customer, 22);
            addRow(rows, 'Tag: ' + txt('custbody_mb_wo_tag'), 22);
            if (options) addRow(rows, options, 22, true);
        } else {
            if (!plainNjAccessory) {
                var soText = 'Stock';
                if (!isStock) {
                    soText = soTranid;
                    var returnCount = String(so.getValue('custbody_yy_so_returncount') || '');
                    if (returnCount) soText += 'R' + returnCount;
                }
                addRow(rows, 'SO#: ' + soText, 28);
                addRow(rows, 'Customer: ' + customer, 22);
                var tag = txt('custbody_mb_wo_tag');
                if (tag) addRow(rows, 'Tag: ' + tag, 22);
            }

            if (yes('custbody_yy_wo_helen')) {
                addRow(rows, 'PO: ' + String(so.getValue('otherrefnum') || ''), 22);
            } else if (yes('custbody_mb_wo_cut_spray')) {
                addRow(rows, 'Cut/Spray', 30);
            } else {
                addRow(rows, 'Box Size: ' + txt('custbody_mb_wo_box_size'), 22);
            }

            var boxParts = [];
            if (modifications) boxParts.push(modifications);
            if (showUom) boxParts.push(uom + ' ft');
            var notes = [mfgNotes, woNotes].filter(Boolean).join(' | ');
            if (notes) boxParts.push(notes);
            if (boxParts.length) addRow(rows, boxParts.join(' / '), 22, true);
        }

        if (isRushAddOn) addRow(rows, 'RUSH ORDER', 36, false, 'C');
        if (isRma && !isCountertop) addRow(rows, 'RMA', 40);

        // ----- Barcode positions (right-aligned) -----
        var woBc = fitBarcode(String(wo.getValue('tranid') || ''), 400, 30);
        var asmBc = fitBarcode(assembly, 772, 420);
        var soBc = fitBarcode(soTranid, 772, 520);

        var label = {
            title: clean(title),
            subtitle: clean(subtitle),
            wonumber: clean(wo.getValue('tranid')),
            woby: String(woBc.by),
            item: clean(assembly),
            asmx: String(asmBc.x),
            asmby: String(asmBc.by),
            components: components,
            rows: rows,
            prodinstr: clean(productionInstr),
            prodinstry: soTranid ? '610' : '720',
            sonumber: clean(soTranid),
            sox: String(soBc.x),
            soby: String(soBc.by),
            managerrush: isManagerRush ? 'T' : 'F',
            printqty: '1'
        };

        // One label per unit
        var labels = [];
        for (var c = 0; c < copies; c++) labels.push(label);
        return labels;
    }

    // ---------- Printer call ----------
    function sendToPrinter(woId, printerId, labels) {

        var options = {
            source: 'WO_' + woId,
            templateId: TEMPLATE_ID,
            printer: Number(printerId),
            async: false,
            processType: 'GENERATE_BEFORE_SEND',
            dataSet: labels
        };

        var requestBody = JSON.stringify({ api: 'printLabels', options: options });

        // What we SEND to the printer API
        logLong('WO ' + woId + ' - REQUEST', requestBody);

        var response = https.requestRestlet({
            scriptId: RESTLET_SCRIPT,
            deploymentId: RESTLET_DEPLOY,
            method: https.Method.POST,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: requestBody
        });

        // What we GET BACK from the printer API
        log.debug('WO ' + woId + ' - RESPONSE CODE', response.code);
        logLong('WO ' + woId + ' - RESPONSE BODY', response.body);

        var result = {};
        try {
            result = JSON.parse(response.body);
        } catch (parseErr) {
            throw new Error('Printer API returned non-JSON: ' + response.body);
        }

        var code = Number(response.code);
        if (code < 200 || code >= 300 || result.success !== true) {
            throw new Error(result.message || result.code ||
                'SIT LPC printing failed (HTTP ' + code + ')');
        }
        return result;
    }

    // ---------- Helpers ----------

    // NetSuite cuts log details at ~3,999 characters, so long text is split into parts
    function logLong(title, text) {
        text = String(text === null || text === undefined ? '' : text);
        var size = 3900;
        var parts = Math.max(1, Math.ceil(text.length / size));
        for (var p = 0; p < parts; p++) {
            log.debug(
                parts > 1 ? title + ' (' + (p + 1) + '/' + parts + ')' : title,
                text.substring(p * size, (p + 1) * size)
            );
        }
    }

    // Text of a field (list/date fields give their display text)
    function fieldText(rec, fieldId) {
        try {
            var t = rec.getText(fieldId);
            if (t !== null && t !== undefined && t !== '') return String(t);
        } catch (e) { /* not a text-able field */ }
        try {
            var v = rec.getValue(fieldId);
            return v === null || v === undefined ? '' : String(v);
        } catch (e2) {
            return '';
        }
    }

    function safeSublistValue(rec, fieldId, line) {
        try {
            return rec.getSublistValue({ sublistId: 'item', fieldId: fieldId, line: line });
        } catch (e) {
            return 0;
        }
    }

    // lookupFields returns arrays for select fields
    function lookupText(v) {
        if (Array.isArray(v)) return v.length ? String(v[0].text || '') : '';
        return v === null || v === undefined ? '' : String(v);
    }

    function isTrue(v) {
        return v === true || v === 'T' || v === 'true' || v === 'Yes';
    }

    // ^ and ~ are ZPL commands, so remove them from data
    function clean(v) {
        return String(v === null || v === undefined ? '' : v).replace(/[\^~]/g, ' ').trim();
    }

    function fmt(n) {
        return String(Math.round(n * 100) / 100);
    }

    // Right-column row. Line count is estimated so rows stack without overlapping.
    function addRow(rows, text, size, box, align) {
        text = clean(text);
        if (!text) return;
        var charsPerLine = Math.max(1, Math.floor(RIGHT_COL_WIDTH / (size * 0.55)));
        var lines = Math.min(4, Math.max(1, Math.ceil(text.length / charsPerLine)));
        rows.push({
            text: text,
            size: String(size),
            lines: String(lines),
            box: box ? 'T' : 'F',
            align: align || 'L'
        });
    }

    // Right-align a Code 128 barcode: estimate its width, use thinner bars if it won't fit
    function fitBarcode(text, rightEdge, minX) {
        var by = 2;
        var width = (String(text).length * 11 + 35) * by;
        if (rightEdge - width < minX) {
            by = 1;
            width = (String(text).length * 11 + 35) * by;
        }
        return { x: Math.max(minX, rightEdge - width), by: by };
    }

    return {
        afterSubmit: afterSubmit
    };
});