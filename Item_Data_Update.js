/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/log', 'N/search'], function (https, log, search) {

    var API_URL = 'https://9rr2n9y68g.execute-api.us-east-1.amazonaws.com/prod/ERPIntegration/CatalogBulkImport';
    var API_KEY = 'BDgy5BS66sPY_UOH3S0m-v3kSBCi25nDDB66Ao4XTPg';

    // TEST & BATCH CONFIGURATION
    var TEST_MODE = false;
    var PAGES_PER_GROUP = 2;     // Number of search pages (1000 items each) per API call. 

    function getInputData() {
        log.audit('STEP 1 - getInputData Started', 'Loading Saved Search: 6139');
        var mySearch = search.load({ id: '6139' });
        var pagedData = mySearch.runPaged({ pageSize: 1000 });
        var totalPages = pagedData.pageRanges.length;

        log.audit('STEP 1 - Total Pages Found', totalPages);

        var totalGroups = Math.ceil(totalPages / PAGES_PER_GROUP);

        // Generate a single unique batch ID for this script execution
        var today = new Date();
        var yyyy = today.getFullYear();
        var mm = today.getMonth() + 1;
        var dd = today.getDate();
        if (mm < 10) mm = '0' + mm;
        if (dd < 10) dd = '0' + dd;
        var dateStr = yyyy + '-' + mm + '-' + dd;
        var batchId = 'netsuite-full-sync-' + dateStr + '-' + Math.floor(today.getTime() / 1000);

        var groups = [];
        for (var g = 0; g < totalGroups; g++) {
            groups.push({
                groupIndex: g,
                batchId: batchId,
                startPageIndex: g * PAGES_PER_GROUP,
                endPageIndex: Math.min((g + 1) * PAGES_PER_GROUP - 1, totalPages - 1)
            });
        }

        if (TEST_MODE) {
            log.audit('STEP 1 - Test Mode Enabled', 'Limiting execution to the first 2 groups');
            groups = groups.slice(0, 2);
        }

        var totalPartsCount = groups.length;
        for (var i = 0; i < totalPartsCount; i++) {
            groups[i].totalParts = totalPartsCount;
        }

        var estimatedItems = groups.length * PAGES_PER_GROUP * 1000;
        log.audit('STEP 1 - Total Groups Created', {
            groupsCount: groups.length,
            itemsPerGroup: PAGES_PER_GROUP * 1000,
            estimatedTotalItems: TEST_MODE ? Math.min(estimatedItems, 10000) : estimatedItems
        });
        return groups;
    }

    function map(context) {
        var group = null;
        try {
            group = JSON.parse(context.value);
            log.audit('STEP 2 - Map Started for Group: ' + group.groupIndex, {
                startPageIndex: group.startPageIndex,
                endPageIndex: group.endPageIndex
            });

            var mySearch = search.load({ id: '6139' });
            var pagedData = mySearch.runPaged({ pageSize: 1000 });

            var items = [];
            var skippedCount = 0;
            for (var pageIdx = group.startPageIndex; pageIdx <= group.endPageIndex; pageIdx++) {
                var page = pagedData.fetch({ index: pageIdx });
                page.data.forEach(function (result) {
                    var itemObj = {
                        sku: result.id,
                        pricingGroup: result.getText({ name: 'pricinggroup' }) || result.getValue({ name: 'pricinggroup' }) || '',
                        ItemNumber: result.getValue({ name: 'itemid' }) || '',
                        cabinet_type: result.getText({ name: 'custitem_mb_item_item_type' }) || result.getValue({ name: 'custitem_mb_item_item_type' }) || '',
                        name: result.getValue({ name: 'salesdescription' }) || '',
                        inventory: Number(result.getValue({ name: 'totalquantityonhand' })) || 0,
                        price: Number(result.getValue({ name: 'baseprice' })) || 0,
                        active: 'true' // Since Saved Search filters: ["isinactive","is","F"], all items are active
                    };

                    // Validate required fields before pushing to chunk payload
                    if (!itemObj.sku || !itemObj.ItemNumber || !itemObj.cabinet_type) {
                        log.error('STEP 2 - Skipping Item due to missing required fields (sku, ItemNumber, or cabinet_type)', JSON.stringify(itemObj));
                        skippedCount++;
                    } else {
                        items.push(itemObj);
                    }
                });
            }

            // Log details for the first 5 items of Group 0 for sanity check
            if (group.groupIndex === 0) {
                for (var i = 0; i < Math.min(items.length, 5); i++) {
                    log.audit('STEP 2 - Group 0 Sample Item ' + i, JSON.stringify(items[i]));
                }
            }

            log.audit('STEP 3 - Sending Group ' + group.groupIndex + ' | Total Items: ' + items.length + ' (Skipped: ' + skippedCount + ')', 'Posting payload to GNI');

            var batchId = group.batchId;

            var payload = {
                sync_type: 'full',
                batch_id: batchId,
                part_index: group.groupIndex + 1,
                total_parts: group.totalParts,
                items: items
            };

            log.debug('payload', payload);

            var response = https.post({
                url: API_URL,
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': API_KEY
                },
                body: JSON.stringify(payload)
            });

            log.audit('STEP 4 - API Response | Group: ' + group.groupIndex, 'Response Code: ' + response.code);

            if (response.code >= 200 && response.code < 300) {
                log.audit('STEP 4 - SUCCESS | Group: ' + group.groupIndex, response.body);
                context.write({
                    key: 'success',
                    value: JSON.stringify({
                        groupIndex: group.groupIndex,
                        sentCount: items.length,
                        skippedCount: skippedCount
                    })
                });
            } else {
                log.error('STEP 4 - FAILED | Group: ' + group.groupIndex, response.body);
                context.write({
                    key: 'failure',
                    value: JSON.stringify({
                        groupIndex: group.groupIndex,
                        sentCount: items.length,
                        skippedCount: skippedCount,
                        error: response.body
                    })
                });
            }

        } catch (e) {
            log.error('STEP 2/4 - Map or API Error for Group: ' + (group ? group.groupIndex : 'unknown'), e);
            try {
                context.write({
                    key: 'system_error',
                    value: JSON.stringify({
                        groupIndex: group ? group.groupIndex : 'unknown',
                        error: e.message || e.toString()
                    })
                });
            } catch (writeErr) {
                log.error('STEP 2/4 - Error writing system error key', writeErr);
            }
        }
    }

    function summarize(summary) {
        log.audit('STEP 5 - Script Completed', {
            usage: summary.usage,
            concurrency: summary.concurrency,
            yields: summary.yields
        });

        var totalSent = 0;
        var totalSkipped = 0;
        var successGroups = [];
        var failedGroups = [];
        var systemErrors = [];

        summary.output.iterator().each(function (key, value) {
            try {
                var data = JSON.parse(value);
                if (key === 'success') {
                    totalSent += data.sentCount;
                    totalSkipped += data.skippedCount;
                    successGroups.push(data.groupIndex);
                } else if (key === 'failure') {
                    totalSkipped += data.skippedCount;
                    failedGroups.push({
                        groupIndex: data.groupIndex,
                        itemCount: data.sentCount,
                        error: data.error
                    });
                } else if (key === 'system_error') {
                    systemErrors.push({
                        groupIndex: data.groupIndex,
                        error: data.error
                    });
                }
            } catch (e) {
                log.error('STEP 5 - Error parsing summary key/value', e);
            }
            return true;
        });

        var stats = {
            status: failedGroups.length === 0 && systemErrors.length === 0 ? 'SUCCESS' : 'COMPLETED_WITH_ERRORS',
            totalItemsSent: totalSent,
            totalItemsSkipped: totalSkipped,
            successGroupsCount: successGroups.length,
            failedGroupsCount: failedGroups.length,
            systemErrorsCount: systemErrors.length,
            successGroups: successGroups,
            failedGroups: failedGroups,
            systemErrors: systemErrors
        };

        log.audit('STEP 5 - Script Completed Stats', JSON.stringify(stats));

        // Display a clean execution summary log
        log.audit('STEP 5 - Execution Summary Report',
            '==================================================\n' +
            ' STATUS: ' + stats.status + '\n' +
            ' TOTAL ITEMS SENT TO GNI: ' + stats.totalItemsSent + '\n' +
            ' TOTAL ITEMS SKIPPED (Missing Required Fields): ' + stats.totalItemsSkipped + '\n' +
            ' SUCCESSFUL BATCHES: ' + stats.successGroupsCount + '\n' +
            ' FAILED BATCHES: ' + stats.failedGroupsCount + '\n' +
            ' SYSTEM TIMEOUTS/ERRORS: ' + stats.systemErrorsCount + '\n' +
            '=================================================='
        );

        if (summary.inputSummary.error) {
            log.error('STEP 5 - Input Stage System Error', summary.inputSummary.error);
        }

        summary.mapSummary.errors.iterator().each(function (key, error) {
            log.error('STEP 5 - Map Stage System Error for Key: ' + key, error);
            return true;
        });
    }

    return {
        getInputData: getInputData,
        map: map,
        summarize: summarize
    };
});
