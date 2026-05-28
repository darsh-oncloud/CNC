/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/sftp', 'N/log'], function (sftp, log) {

    var CONFIG = {
        username: 'cncecbarton.dhruvsoni',
        url: 'cncecbarton.blob.core.windows.net',
        port: 22,
        directory: '/',
        passwordGuid: 'bae5a79216ae4cad8e220f41d6d368d9',
        hostKey: 'AAAAB3NzaC1yc2EAAAADAQABAAABAQCxCnn/udlkksnGAo7oaReFeIadPCUA+edUXEf4Y/4sUafDdwYmxvm7ryS6DbpbDHDB53Z0iePiKjCuBDe75X7/qulFBx6XIWc9Y6orRaqCj1De7IEHuATyMXBcnY9XZyRvqupLX80nvWcwD4Iiep2DRt4uqP8aLrww3gUv88Oqozy52psmR0RR6p/f63CcuI5G/agD5QzjSKwNmkInelc64pfNJjgOnwOPESf7M9p+GV6xjoS0l9nHMyjz3vh5GXpfUuGtffrpjd8S53jtftloBqdGDT8FBKyP8eWhYj4m2Nb60VqgDUru2L6rkWriJ41wJ60yzy/3TyuJOswnTlal',
        hostKeyType: 'rsa',
        timeout: 20
    };

    function getInputData() {
        try {
            log.audit('TEST START', 'Trying SFTP connection');

            var connection = sftp.createConnection({
                username: CONFIG.username,
                passwordGuid: CONFIG.passwordGuid,
                url: CONFIG.url,
                port: CONFIG.port,
                directory: CONFIG.directory,
                hostKey: CONFIG.hostKey,
                hostKeyType: CONFIG.hostKeyType,
                timeout: CONFIG.timeout
            });

            log.audit('TEST CONNECTED', 'SFTP connection successful');

            var fileList = connection.list({
                path: CONFIG.directory
            }) || [];

            log.audit('TEST FILE COUNT', fileList.length);

            for (var i = 0; i < fileList.length; i++) {
                log.audit('TEST FILE ' + i, {
                    name: fileList[i].name,
                    directory: fileList[i].directory,
                    size: fileList[i].size
                });
            }

        } catch (e) {
            log.error('TEST SFTP ERROR', {
                name: e.name,
                message: e.message
            });
        }

        return [];
    }

    function summarize(summary) {
        log.audit('TEST SUMMARY', 'Connection test completed');

        if (summary.inputSummary.error) {
            log.error('TEST INPUT ERROR', summary.inputSummary.error);
        }
    }

    return {
        getInputData: getInputData,
        summarize: summarize
    };
});