/**
* @NApiVersion 2.1
* @NScriptType MapReduceScript
*/
define(['N/sftp', 'N/log', 'N/runtime'], function (sftp, log, runtime) {
 
    var CONFIG = {
        username: 'cncecbarton.dhruvsoni',
        url: 'cncecbarton.blob.core.windows.net',
        port: 22,
        directory: '/',
        passwordGuid: 'bae5a79216ae4cad8e220f41d6d368d9',
        hostKey: 'AAAAB3NzaC1yc2EAAAADAQABAAABAQC3XT+gvZTEoyvOJiiP1YiVSqpWbWxbjF+NNqwnlT3KZWRcnLYi7mwTQIrq+G8vAYW5Q2Q+RGMDfjAMZSzQH9HuGIROQWF549jH8B61TirsfnFYMKrFJWILAkjzli3g+vB8b6i9FTwh7CA6RmN/wqaDccTHz7MXPlqbWHdMiyj3PERS5qaJJoVoyRm5HTGnWr5BG6eQpzBPsZMuFO1Ek7u9ebBsNiQpyGLkZXP7bxU3+wgq5jXAPmGkgcNRj3LMENg949xCaRfCIUBcnctv1DzwKb6YLhoYoAbun2CthRbOsK25FEqTG/Kg+vD220HiaTH0KIixffhTrvkzhlAKdscd',
       // hostKey: 'AAAAB3NzaC1yc2EAAAADAQABAAABAQCxCnn/udlkksnGAo7oaReFeIadPCUA+edUXEf4Y/4sUafDdwYmxvm7ryS6DbpbDHDB53Z0iePiKjCuBDe75X7/qulFBx6XIWc9Y6orRaqCj1De7IEHuATyMXBcnY9XZyRvqupLX80nvWcwD4Iiep2DRt4uqP8aLrww3gUv88Oqozy52psmR0RR6p/f63CcuI5G/agD5QzjSKwNmkInelc64pfNJjgOnwOPESf7M9p+GV6xjoS0l9nHMyjz3vh5GXpfUuGtffrpjd8S53jtftloBqdGDT8FBKyP8eWhYj4m2Nb60VqgDUru2L6rkWriJ41wJ60yzy/3TyuJOswnTlal',
        hostKeyType: 'rsa',
        timeout: 20
    };
 
    var TARGET_FOLDER_ID = 37467318;
    var MAX_FILES_PER_RUN = 50;
    var MIN_USAGE_LEFT = 300;
 
    function getRemainingUsage() {
        return runtime.getCurrentScript().getRemainingUsage();
    }
 
    function isCsv(fileName) {
        return fileName && fileName.toLowerCase().slice(-4) === '.csv';
    }
 
    function buildFilePath(directory, fileName) {
        if (!directory || directory === '/') {
            return '/' + fileName;
        }
        if (directory.charAt(directory.length - 1) === '/') {
            return directory + fileName;
        }
        return directory + '/' + fileName;
    }
 
    function getInputData() {
        var connection;
        var fileList = [];
        var processed = 0;
        var saved = 0;
        var removed = 0;
        var skipped = 0;
        var failed = 0;
 
        try {
            log.audit('START', 'Connecting to SFTP');
 
            connection = sftp.createConnection({
                username: CONFIG.username,
                passwordGuid: CONFIG.passwordGuid,
                url: CONFIG.url,
                port: CONFIG.port,
                directory: CONFIG.directory,
                hostKey: CONFIG.hostKey,
                hostKeyType: CONFIG.hostKeyType,
                timeout: CONFIG.timeout
            });
 
            log.audit('CONNECTED', 'SFTP connection successful');
 
            fileList = connection.list({
                path: CONFIG.directory
            }) || [];
 
            log.audit('FILES FOUND', 'Total files found: ' + fileList.length);
 
            for (var i = 0; i < fileList.length; i++) {
                var remainingUsage = getRemainingUsage();
 
                if (remainingUsage < MIN_USAGE_LEFT) {
                    log.audit('STOPPED', 'Low usage left: ' + remainingUsage);
                    break;
                }
 
                if (processed >= MAX_FILES_PER_RUN) {
                    log.audit('STOPPED', 'Max files processed in this run: ' + MAX_FILES_PER_RUN);
                    break;
                }
 
                var sftpFileObj = fileList[i];
                var fileName = sftpFileObj && sftpFileObj.name ? sftpFileObj.name : '';
 
                if (!isCsv(fileName)) {
                    skipped++;
                    continue;
                }
 
                processed++;
                log.audit('PROCESSING FILE', fileName);
 
                try {
                    var downloadedFile = connection.download({
                        directory: CONFIG.directory,
                        filename: fileName
                    });
 
                    downloadedFile.folder = TARGET_FOLDER_ID;
                    var fileId = downloadedFile.save();
 
                    saved++;
                    log.audit('FILE SAVED', 'File: ' + fileName + ' | File ID: ' + fileId);
 
 
                    connection.move({
                      from: buildFilePath(CONFIG.directory, fileName),
                      to: buildFilePath('/processed', fileName)
                    });
 
                    // connection.removeFile({
                    //     path: buildFilePath(CONFIG.directory, fileName)
                    // });
 
                    removed++;
                    log.audit('FILE MOVED', fileName);
 
                } catch (fileErr) {
                    failed++;
                    log.error('FILE ERROR', {
                        fileName: fileName,
                        name: fileErr.name,
                        message: fileErr.message
                    });
                }
            }
 
            log.audit('GET INPUT COMPLETE', {
                processed: processed,
                saved: saved,
                removed: removed,
                skipped: skipped,
                failed: failed,
                remainingUsage: getRemainingUsage()
            });
 
        } catch (e) {
            log.error('SFTP ERROR', {
                name: e.name,
                message: e.message
            });
        }
 
        return [];
    }
 
    function summarize(summary) {
        log.audit('SUMMARY', 'Script completed');
 
        if (summary.inputSummary.error) {
            log.error('INPUT ERROR', summary.inputSummary.error);
        }
    }
 
    return {
        getInputData: getInputData,
        summarize: summarize
    };
});