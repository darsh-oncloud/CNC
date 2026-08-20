/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 *
 * Description: RESTlet to process incoming JSON payload (header + child array)
 * and create/link Product Lists and Product Lists Items records.
 */
define(['N/record', 'N/search', 'N/log', 'N/url', 'N/runtime'], (record, search, log, url, runtime) => {

    const CONFIG = {
        RECORD_TYPES: {
            PARENT: 'customrecord_ns_pl_productlist',
            CHILD: 'customrecord_ns_pl_productlistitem'
        },
        PARENT_FIELDS: {
            STATUS: 'custrecord_rsm_pl_pl_status',
            EMAIL: 'custrecord_rsm_pl_pl_contacts_email',
            PO_NUMBER: 'custrecord_rsm_pl_po_number',
            RECEIVE_PAYLOAD: 'custrecord_receive_payload'
        },
        CHILD_FIELDS: {
            PRODUCT_LIST: 'custrecord_ns_pl_pli_productlist',
            ITEM: 'custrecord_ns_pl_pli_item',
            DESCRIPTION: 'custrecord_ns_pl_pli_description',
            QUANTITY: 'custrecord_ns_pl_pli_quantity',
            PRIORITY: 'custrecord_ns_pl_pli_priority',
            OPTIONS: 'custrecord_ns_pl_pli_options'
        },
        LIST_IDS: {
            scope: 'customlist_ns_pl_scope',
            type: 'customlist_ns_pl_type',
            status: 'customlist_rsm_pl_status',
            priority: 'customrecord_ns_pl_pli_priority'
        },
        ITEM_FIELDS: {
            COLLECTION: 'custitem_mb_cncproductline',
            GROUP_NUMBER: 'custitem_mb_item_group',
            STYLE: 'custitem_mb_item_style',
            COLOR: 'custitem_mb_item_color',
            ITEM_OPTIONS: 'custitem_yy_options'
        }
    };

    const PARENT_REC = CONFIG.RECORD_TYPES.PARENT;
    const CHILD_REC = CONFIG.RECORD_TYPES.CHILD;
    const LIST_IDS = CONFIG.LIST_IDS;

    /**
     * Handles POST requests.
     * Expected payload shape:
     * {
     *   ...header fields...,
     *   child: [ { ...child fields... }, { ...child fields... } ]
     * }
     */
    const post = (requestBody) => {
        try {
            log.audit({
                title: 'Received Product List Creation Request',
                details: JSON.stringify(requestBody)
            });

            // 1. Resolve or Create Parent Record (Product List)
            const parentId = getOrCreateProductList(requestBody);

            // 2. Process Child Array
            const children = Array.isArray(requestBody.child) ? requestBody.child : [];
            if (children.length === 0) {
                throw new Error("Missing required 'child' array with at least one item line.");
            }

            const childRecordIds = [];
            const failedLines = [];

            // Pre-load all existing child records for this parent list to prevent duplication
            const existingChildMap = {};
            try {
                search.create({
                    type: CHILD_REC,
                    filters: [['custrecord_ns_pl_pli_productlist', 'anyof', parentId]],
                    columns: ['internalid', 'custrecord_ns_pl_pli_options']
                }).run().each(result => {
                    const optionsStr = result.getValue('custrecord_ns_pl_pli_options') || '';
                    if (optionsStr) {
                        try {
                            const parsed = JSON.parse(optionsStr);
                            const uidOption = parsed['custcol_rsm_line_uid'] || parsed['CUSTCOL_RSM_LINE_UID'];
                            if (uidOption && uidOption.value) {
                                existingChildMap[uidOption.value] = result.id;
                            }
                        } catch (e) {
                            // ignore
                        }
                    }
                    return true;
                });
                log.debug('Pre-loaded Existing Child Records Map', JSON.stringify(existingChildMap));
            } catch (searchErr) {
                log.error('Error pre-loading existing child records map', searchErr.toString());
            }

            children.forEach((childData, idx) => {
                const itemSku = childData.custrecord_ns_pl_pli_item;
                try {
                    if (!itemSku) {
                        throw new Error(`Missing 'custrecord_ns_pl_pli_item' on child line index ${idx}.`);
                    }
                    const nsItemId = getItemInternalId(itemSku);
                    if (!nsItemId) {
                        throw new Error(`Could not find a NetSuite Item matching SKU: "${itemSku}" (child index ${idx}).`);
                    }

                    // Look up item metadata (collection, groupNumber, style, color, options) dynamically
                    let itemCollection = '';
                    let itemGroupNumber = '';
                    let itemStyle = '';
                    let itemColor = '';
                    let itemColorText = '';
                    let isCplusColor = false;
                    let isCplusStain = false;
                    try {
                        const itemFields = search.lookupFields({
                            type: 'item',
                            id: nsItemId,
                            columns: [
                                CONFIG.ITEM_FIELDS.COLLECTION,
                                CONFIG.ITEM_FIELDS.GROUP_NUMBER,
                                CONFIG.ITEM_FIELDS.STYLE,
                                CONFIG.ITEM_FIELDS.COLOR,
                                CONFIG.ITEM_FIELDS.ITEM_OPTIONS
                            ]
                        });

                        if (itemFields[CONFIG.ITEM_FIELDS.COLLECTION] && itemFields[CONFIG.ITEM_FIELDS.COLLECTION].length > 0) {
                            itemCollection = itemFields[CONFIG.ITEM_FIELDS.COLLECTION][0].value;
                        }
                        if (itemFields[CONFIG.ITEM_FIELDS.GROUP_NUMBER] && itemFields[CONFIG.ITEM_FIELDS.GROUP_NUMBER].length > 0) {
                            itemGroupNumber = itemFields[CONFIG.ITEM_FIELDS.GROUP_NUMBER][0].value;
                        }
                        if (itemFields[CONFIG.ITEM_FIELDS.STYLE] && itemFields[CONFIG.ITEM_FIELDS.STYLE].length > 0) {
                            itemStyle = itemFields[CONFIG.ITEM_FIELDS.STYLE][0].value;
                        }
                        if (itemFields[CONFIG.ITEM_FIELDS.COLOR] && itemFields[CONFIG.ITEM_FIELDS.COLOR].length > 0) {
                            itemColor = itemFields[CONFIG.ITEM_FIELDS.COLOR][0].value;
                            itemColorText = itemFields[CONFIG.ITEM_FIELDS.COLOR][0].text;
                        }

                        // Determine if item supports Color Plus Paint or Stain
                        let itemOptionsVal = itemFields[CONFIG.ITEM_FIELDS.ITEM_OPTIONS];
                        if (itemOptionsVal) {
                            let optString = '';
                            if (Array.isArray(itemOptionsVal)) {
                                optString = itemOptionsVal.map(function (o) { return o.text || o.value || ''; }).join(',');
                            } else if (typeof itemOptionsVal === 'object') {
                                optString = itemOptionsVal.text || itemOptionsVal.value || '';
                            } else {
                                optString = String(itemOptionsVal);
                            }

                            optString = optString.toUpperCase();
                            if (optString.indexOf('CUSTCOL_YY_MOD_CPLUS_COLOR') !== -1 || optString.indexOf('PLUS PAINT COLORS') !== -1) {
                                isCplusColor = true;
                            }
                            if (optString.indexOf('CUSTCOL_ER_MOD_CPLUS_STAIN') !== -1 || optString.indexOf('PLUS STAIN COLORS') !== -1) {
                                isCplusStain = true;
                            }
                        }
                    } catch (lookupErr) {
                        log.debug('Failed to look up item properties with standard IDs', lookupErr.message || lookupErr.toString());
                        try {
                            const altFields = search.lookupFields({
                                type: 'item',
                                id: nsItemId,
                                columns: ['class']
                            });
                            if (altFields.class && altFields.class.length > 0) {
                                itemStyle = altFields.class[0].value;
                            }
                        } catch (e) {
                            // ignore
                        }
                    }

                    // custrecord_ns_pl_pli_options expects a JSON string on the record
                    let optionsVal = childData.custrecord_ns_pl_pli_options || {};
                    if (typeof optionsVal === 'string') {
                        try {
                            optionsVal = JSON.parse(optionsVal);
                        } catch (e) {
                            log.error({
                                title: 'Error parsing optionsVal',
                                details: e.toString()
                            });
                            optionsVal = {};
                        }
                    }

                    let lineUid = '';
                    if (optionsVal && typeof optionsVal === 'object') {
                        const uidOption = optionsVal['custcol_rsm_line_uid'] || optionsVal['CUSTCOL_RSM_LINE_UID'];
                        if (uidOption && typeof uidOption === 'object') {
                            lineUid = uidOption.value;
                        }
                    }

                    // Check if a line with the same UID already exists under this parent
                    let existingChildId = null;
                    if (lineUid && existingChildMap.hasOwnProperty(lineUid)) {
                        existingChildId = existingChildMap[lineUid];
                    }

                    let childRec;
                    if (existingChildId) {
                        log.debug(`[Line ${idx} | SKU: ${itemSku}] Updating Existing Child Line`, `Loading existing Product List Item ID: ${existingChildId} for UID: ${lineUid}`);
                        childRec = record.load({
                            type: CHILD_REC,
                            id: existingChildId,
                            isDynamic: true
                        });
                    } else {
                        log.debug(`[Line ${idx} | SKU: ${itemSku}] Creating New Child Line`, `Creating new Product List Item for UID: ${lineUid}`);
                        childRec = record.create({
                            type: CHILD_REC,
                            isDynamic: true
                        });
                    }

                    childRec.setValue({
                        fieldId: 'custrecord_ns_pl_pli_productlist',
                        value: parentId
                    });

                    childRec.setValue({
                        fieldId: 'custrecord_ns_pl_pli_item',
                        value: nsItemId
                    });

                    childRec.setValue({
                        fieldId: 'custrecord_ns_pl_pli_description',
                        value: childData.custrecord_ns_pl_pli_description || ''
                    });

                    childRec.setValue({
                        fieldId: 'custrecord_ns_pl_pli_quantity',
                        value: parseInt(childData.custrecord_ns_pl_pli_quantity, 10) || 1
                    });

                    const priorityId = resolveListValue(LIST_IDS.priority, childData.custrecord_ns_pl_pli_priority);
                    if (priorityId) {
                        childRec.setValue({
                            fieldId: 'custrecord_ns_pl_pli_priority',
                            value: priorityId
                        });
                    }

                    // Iterate through all keys in optionsVal and clean/stringify as required
                    if (optionsVal && typeof optionsVal === 'object') {
                        // Pass 1: Determine if this is a charge line
                        let isChargeLine = false;
                        const jsonOption = optionsVal['custcol_rsm_line_json'];
                        if (jsonOption && typeof jsonOption === 'object') {
                            let jsonVal = jsonOption.value;
                            if (typeof jsonVal === 'string') {
                                try {
                                    jsonVal = JSON.parse(jsonVal);
                                } catch (e) {
                                    // ignore
                                }
                            }
                            if (jsonVal && typeof jsonVal === 'object') {
                                if (jsonVal.lineType === 'charge' || jsonVal.parentUid) {
                                    isChargeLine = true;
                                }
                            }
                        }

                        // Inject Color Plus options if the item supports them and we resolved itemColor
                        if (!isChargeLine) {
                            let payloadColorCode = '';
                            const jsonOption = optionsVal['custcol_rsm_line_json'];
                            if (jsonOption && typeof jsonOption === 'object') {
                                let jsonVal = jsonOption.value;
                                if (typeof jsonVal === 'string') {
                                    try {
                                        jsonVal = JSON.parse(jsonVal);
                                    } catch (e) {
                                        // ignore
                                    }
                                }
                                if (jsonVal && typeof jsonVal === 'object') {
                                    payloadColorCode = jsonVal.colorCode || '';
                                }
                            }

                            let resolvedPaintColorId = null;
                            let resolvedStainColorId = null;

                            if (payloadColorCode && (isCplusColor || isCplusStain)) {
                                resolvedPaintColorId = findColorIdByCode(payloadColorCode);
                                if (!resolvedPaintColorId) {
                                    resolvedStainColorId = findStainIdByCode(payloadColorCode);
                                }
                            }

                            log.debug(`[Line ${idx} | SKU: ${itemSku}] Color Variables`, JSON.stringify({
                                itemColor: itemColor,
                                itemColorText: itemColorText,
                                isCplusColor: isCplusColor,
                                isCplusStain: isCplusStain,
                                payloadColorCode: payloadColorCode,
                                resolvedPaintColorId: resolvedPaintColorId,
                                resolvedStainColorId: resolvedStainColorId
                            }));

                            if (resolvedPaintColorId) {
                                optionsVal['custcol_yy_mod_cplus_color'] = {
                                    value: String(resolvedPaintColorId),
                                    displayvalue: String(resolvedPaintColorId)
                                };
                            } else if (resolvedStainColorId) {
                                optionsVal['custcol_er_mod_cplus_stain'] = {
                                    value: String(resolvedStainColorId),
                                    displayvalue: String(resolvedStainColorId)
                                };
                            } else if (itemColor) {
                                if (isCplusColor) {
                                    optionsVal['custcol_yy_mod_cplus_color'] = {
                                        value: String(itemColor),
                                        displayvalue: String(itemColor)
                                    };
                                }
                                if (isCplusStain) {
                                    optionsVal['custcol_er_mod_cplus_stain'] = {
                                        value: String(itemColor),
                                        displayvalue: String(itemColor)
                                    };
                                }
                            }
                        }

                        const keysToDelete = [];

                        for (const key in optionsVal) {
                            if (optionsVal.hasOwnProperty(key)) {
                                const option = optionsVal[key];
                                if (option && typeof option === 'object') {
                                    const cleanKey = key.toLowerCase();
                                    if (cleanKey === 'custcol_rsm_line_json') {
                                        let jsonVal = option.value;
                                        if (typeof jsonVal === 'string') {
                                            try {
                                                jsonVal = JSON.parse(jsonVal);
                                            } catch (jsonErr) {
                                                log.error(`[Line ${idx} | SKU: ${itemSku}] Error parsing custcol_rsm_line_json string`, jsonErr.toString());
                                            }
                                        }
                                        if (jsonVal && typeof jsonVal === 'object') {
                                            // Remove the options property if it exists
                                            delete jsonVal.options;
                                            delete jsonVal.chaseCutSketchUrl;
                                            delete jsonVal.chasecutsketchurl;

                                            // Always remove the "order" property from custcol_rsm_line_json
                                            delete jsonVal.order;

                                            if (isChargeLine) {
                                                // Charge line specific processing if any in future
                                            } else {
                                                // It's an item line's custcol_rsm_line_json:
                                                // 1. Remove colorCode and overwrite color with NetSuite item color ID (parsed as number)
                                                delete jsonVal.colorCode;
                                                if (itemColor) {
                                                    jsonVal.color = !isNaN(itemColor) ? parseInt(itemColor, 10) : itemColor;
                                                }
                                                // 2. Overwrite colorText with NetSuite item color label text
                                                if (itemColorText) {
                                                    jsonVal.colorText = itemColorText;
                                                }
                                                // 3. Add missing documented properties (collection, groupNumber, style)
                                                if (itemCollection) {
                                                    jsonVal.collection = !isNaN(itemCollection) ? parseInt(itemCollection, 10) : itemCollection;
                                                }
                                                if (itemGroupNumber) {
                                                    jsonVal.groupNumber = !isNaN(itemGroupNumber) ? parseInt(itemGroupNumber, 10) : itemGroupNumber;
                                                }
                                                if (itemStyle) {
                                                    jsonVal.style = !isNaN(itemStyle) ? parseInt(itemStyle, 10) : itemStyle;
                                                }
                                            }

                                            const stringified = JSON.stringify(jsonVal);
                                            option.value = stringified;
                                            option.displayvalue = stringified;
                                        }
                                    } else if (cleanKey === 'custcol_rsm_line_uid') {
                                        if (option.hasOwnProperty('value')) {
                                            option.displayvalue = option.value;
                                        }
                                    } else {
                                        // For all other fields (option fields):
                                        if (isChargeLine) {
                                            // On a charge line, do not set/include any options (delete them)
                                            keysToDelete.push(key);
                                        } else {
                                            if (option.hasOwnProperty('value')) {
                                                option.displayvalue = option.value;
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // Perform deletion of stripped option fields for charge lines
                        keysToDelete.forEach(function (k) {
                            delete optionsVal[k];
                        });
                    }

                    childRec.setValue({
                        fieldId: 'custrecord_ns_pl_pli_options',
                        value: JSON.stringify(optionsVal)
                    });

                    const childId = childRec.save();
                    childRecordIds.push(childId);
                } catch (lineErr) {
                    log.error(`[Line ${idx} | SKU: ${itemSku || 'N/A'}] Failed to process child line`, lineErr.message || lineErr.toString());
                    failedLines.push({
                        sku: itemSku || `LineIndex_${idx}`,
                        error: lineErr.message || lineErr.toString()
                    });
                }
            });

            // 3. Update Parent Status at the very end to prevent it from being overridden by Child Record User Events/Workflows
            const statusParam = runtime.getCurrentScript().getParameter({ name: 'custscript_product_list_status' });
            log.debug('Final Parent Status Update Info', `Raw statusParam: ${statusParam}, parentId: ${parentId}`);
            if (statusParam) {
                const statusId = resolveListValue(LIST_IDS.status, statusParam);
                log.debug('Final Parent Status ID Resolved', `Resolved status ID: ${statusId}`);
                if (statusId) {
                    try {
                        record.submitFields({
                            type: PARENT_REC,
                            id: parentId,
                            values: {
                                'custrecord_rsm_pl_pl_status': statusId
                            }
                        });
                        log.audit('Parent List Status Set to Final Value', `Updated Product List ID: ${parentId} status to: ${statusId}`);
                    } catch (submitErr) {
                        log.error('Final Submit Fields Failed', `Failed to update status on Parent List ID: ${parentId}. Error: ${submitErr.message || submitErr.toString()}`);
                    }
                }
            }

            log.audit({
                title: 'Records Successfully Processed',
                details: `Header ID: ${parentId}, Child IDs: ${childRecordIds.join(', ')}, Failed Lines: ${failedLines.length}`
            });

            let baseUrl = runtime.getCurrentScript().getParameter({ name: 'custscript_cabinate_base_url' }) || 'https://cnc.rsmusstaging.com/sca-dev-2023-2-0/my_account.ssp#/drafts';
            if (baseUrl.endsWith('/')) {
                baseUrl = baseUrl.slice(0, -1);
            }

            return {
                success: true,
                headerRecordId: parentId,
                headerRecordUrl: buildRecordUrl(PARENT_REC, parentId),
                draftUrl: `${baseUrl}/${parentId}`,
                poNumber: requestBody.custrecord_rsm_pl_po_number || '',
                childRecordIds: childRecordIds,
                failedLines: failedLines,
                message: failedLines.length > 0
                    ? `Processed successfully with ${failedLines.length} skipped item(s).`
                    : 'Product List and Item(s) successfully processed.'
            };

        } catch (e) {
            log.error({
                title: 'Error Processing RESTlet Payload',
                details: e.toString()
            });
            return {
                success: false,
                message: e.message || e.toString()
            };
        }
    };

    function getOrCreateProductList(data) {
        const parentName = data.name || data.parent_name || 'Unnamed Product List';
        let parentId = null;

        search.create({
            type: PARENT_REC,
            filters: [['name', 'is', parentName]],
            columns: ['internalid']
        }).run().each(result => {
            parentId = result.id;
            return false;
        });

        if (parentId) {
            log.debug('Parent List Exists', `Found existing Product List ID: ${parentId}`);
            try {
                var payloadFieldsObj = {};
                payloadFieldsObj[CONFIG.PARENT_FIELDS.RECEIVE_PAYLOAD] = JSON.stringify(data);
                record.submitFields({
                    type: PARENT_REC,
                    id: parentId,
                    values: payloadFieldsObj
                });
                log.audit('Updated Raw Payload on Existing Parent', `Parent List ID: ${parentId}`);
            } catch (payloadErr) {
                log.error('Failed to submit raw payload on existing parent list', payloadErr.message || payloadErr.toString());
            }
            return parentId;
        }

        log.debug('Creating Parent Record', `Creating new Product List: "${parentName}"`);
        const parentRec = record.create({
            type: PARENT_REC,
            isDynamic: true
        });

        parentRec.setValue({ fieldId: 'name', value: parentName });
        parentRec.setValue({ fieldId: 'custrecord_ns_pl_pl_description', value: data.custrecord_ns_pl_pl_description || '' });
        parentRec.setValue({ fieldId: 'custrecord_ns_pl_pl_templateid', value: data.custrecord_ns_pl_pl_templateid || '' });
        parentRec.setValue({ fieldId: 'custrecord_rsm_pl_thumbnail', value: data.custrecord_rsm_pl_thumbnail || '' });
        parentRec.setValue({ fieldId: 'custrecord_rsm_pl_style_name', value: data.custrecord_rsm_pl_style_name || '' });
        parentRec.setValue({ fieldId: 'custrecord_rsm_pl_po', value: data.custrecord_rsm_pl_po || '' });
        parentRec.setValue({ fieldId: 'custrecord_rsm_pl_tot_cab', value: data.custrecord_rsm_pl_tot_cab || '' });
        parentRec.setValue({ fieldId: 'custrecord_rsm_pl_pl_contacts_email', value: data.custrecord_rsm_pl_pl_contacts_email || '' });
        parentRec.setValue({ fieldId: 'custrecord_rsm_pl_po_number', value: data.custrecord_rsm_pl_po_number || '' });
        parentRec.setValue({ fieldId: 'custrecord_rsm_pl_order_tag', value: data.custrecord_rsm_pl_order_tag || '' });

        const email = data.custrecord_rsm_pl_pl_contacts_email;
        let ownerId = resolveEntity(data.custrecord_ns_pl_pl_owner);
        if (!ownerId && email) {
            ownerId = resolveCustomerFromEmail(email);
        }
        if (ownerId) {
            parentRec.setValue({ fieldId: 'custrecord_ns_pl_pl_owner', value: ownerId });
        }

        const scopeId = resolveListValue(LIST_IDS.scope, data.custrecord_ns_pl_pl_scope);
        if (scopeId) {
            parentRec.setValue({ fieldId: 'custrecord_ns_pl_pl_scope', value: scopeId });
        }

        const typeId = resolveListValue(LIST_IDS.type, data.custrecord_ns_pl_pl_type);
        if (typeId) {
            parentRec.setValue({ fieldId: 'custrecord_ns_pl_pl_type', value: typeId });
        }



        // Store raw incoming receive payload
        parentRec.setValue({
            fieldId: CONFIG.PARENT_FIELDS.RECEIVE_PAYLOAD,
            value: JSON.stringify(data)
        });

        parentId = parentRec.save();
        log.audit('Parent List Created', `Product List ID: ${parentId}`);
        return parentId;
    }

    /**
     * Builds a full absolute URL to a custom record entry page.
     * Uses N/url.resolveRecord to get the relative path (handles rectype
     * resolution for custom records automatically), then prepends the
     * account's domain derived from N/runtime.accountId.
     *
     * Example output:
     * https://5387755-sb1.app.netsuite.com/app/common/custom/custrecordentry.nl?rectype=2124&id=21801
     */
    function buildRecordUrl(recordType, recordId) {
        try {
            const relativeUrl = url.resolveRecord({
                recordType: recordType,
                recordId: recordId,
                isEditMode: false
            });

            // N/runtime.accountId returns e.g. "5387755_SB1"; domain form is "5387755-sb1"
            const accountId = runtime.accountId || '';
            const domainAccountId = accountId.replace(/_/g, '-').toLowerCase();
            const domain = `https://${domainAccountId}.app.netsuite.com`;

            return `${domain}${relativeUrl}`;
        } catch (e) {
            log.error({
                title: 'Failed to Build Record URL',
                details: e.toString()
            });
            return '';
        }
    }

    function findColorIdByCode(colorCode) {
        if (!colorCode) return null;
        let colorId = null;
        try {
            let codesToCheck = [colorCode];
            let stripped = colorCode.replace(/^0+/, '');
            if (stripped && stripped !== colorCode) {
                codesToCheck.push(stripped);
            } else if (colorCode.length === 1) {
                codesToCheck.push('0' + colorCode);
            }

            search.create({
                type: 'customlist_yy_cplus_color',
                columns: ['name']
            }).run().each(result => {
                let name = result.getValue('name');
                for (let c = 0; c < codesToCheck.length; c++) {
                    let code = codesToCheck[c];
                    let regex = new RegExp('^' + code + '\\b');
                    if (regex.test(name)) {
                        colorId = result.id;
                        return false; // stop iteration
                    }
                }
                return true;
            });
        } catch (e) {
            log.error('Error finding paint color ID for code: ' + colorCode, e.message || e.toString());
        }
        return colorId;
    }

    function findStainIdByCode(colorCode) {
        if (!colorCode) return null;
        let stainId = null;
        try {
            let codesToCheck = [colorCode];
            let stripped = colorCode.replace(/^0+/, '');
            if (stripped && stripped !== colorCode) {
                codesToCheck.push(stripped);
            } else if (colorCode.length === 1) {
                codesToCheck.push('0' + colorCode);
            }

            search.create({
                type: 'customlist_er_cplus_stain',
                columns: ['name']
            }).run().each(result => {
                let name = result.getValue('name');
                for (let c = 0; c < codesToCheck.length; c++) {
                    let code = codesToCheck[c];
                    let regex = new RegExp('^' + code + '\\b');
                    if (regex.test(name)) {
                        stainId = result.id;
                        return false; // stop iteration
                    }
                }
                return true;
            });
        } catch (e) {
            log.error('Error finding stain color ID for code: ' + colorCode, e.message || e.toString());
        }
        return stainId;
    }

    function resolveEntity(entityVal) {
        if (!entityVal) return null;
        if (!isNaN(entityVal)) return parseInt(entityVal, 10);

        let entityId = null;
        search.create({
            type: 'customer',
            filters: [
                ['entityid', 'is', entityVal],
                'OR',
                ['altname', 'is', entityVal]
            ],
            columns: ['internalid']
        }).run().each(result => {
            entityId = result.id;
            return false;
        });
        return entityId;
    }

    function resolveCustomerFromEmail(email) {
        if (!email) return null;
        let customerId = null;

        // 1. Try to find customer directly by email
        try {
            search.create({
                type: 'customer',
                filters: [['email', 'is', email]],
                columns: ['internalid']
            }).run().each(result => {
                customerId = result.id;
                return false;
            });
        } catch (e) {
            log.error('Customer Search Failed', 'Error querying customer by email: ' + email + '. Error: ' + e.message);
        }

        if (customerId) return customerId;

        // 2. If not found, try to find contact by email and get their company (customer)
        try {
            search.create({
                type: 'contact',
                filters: [['email', 'is', email]],
                columns: ['company']
            }).run().each(result => {
                customerId = result.getValue('company');
                return false;
            });
        } catch (e) {
            log.error('Contact Search Failed', 'Error querying contact by email: ' + email + '. Error: ' + e.message);
        }

        return customerId;
    }

    function resolveListValue(listType, val) {
        if (!val) return null;
        log.debug('resolveListValue Input', `listType: ${listType}, val: ${val}`);
        if (!isNaN(val)) return parseInt(val, 10);

        let optionId = null;
        try {
            search.create({
                type: listType,
                filters: [['name', 'is', val]],
                columns: ['internalid']
            }).run().each(result => {
                optionId = result.id;
                return false;
            });
        } catch (e) {
            log.error('List Lookup Failed', `Could not query list type: "${listType}". Error: ${e.message}`);
        }
        log.debug('resolveListValue Output', `Resolved optionId: ${optionId}`);
        return optionId;
    }

    function getItemInternalId(sku) {
        let itemId = null;
        search.create({
            type: 'item',
            filters: [
                ['name', 'is', sku],
                'OR',
                ['itemid', 'is', sku]
            ],
            columns: ['internalid']
        }).run().each(result => {
            itemId = result.id;
            return false;
        });
        return itemId;
    }

    return { post };
});