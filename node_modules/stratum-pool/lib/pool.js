var events = require('events');
var async = require('async');

var varDiff = require('./varDiff.js');
var daemon = require('./daemon.js');
var peer = require('./peer.js');
var stratum = require('./stratum.js');
var jobManager = require('./jobManager.js');
var util = require('./util.js');

/*process.on('uncaughtException', function(err) {
    console.log(err.stack);
    throw err;
});*/

var pool = module.exports = function pool(options, authorizeFn, logger) {

    this.options = options;

    var _this = this;
    var blockPollingIntervalId;


    if (!(options.coin.algorithm in algos)) {
        logger.error('The %s hashing algorithm is not supported.', options.coin.algorithm);
        throw new Error();
    }


    this.start = function () {
        SetupVarDiff();
        SetupApi();
        SetupDaemonInterface(function () {
            DetectCoinData(function () {
                SetupRecipients();
                SetupJobManager();
                OnBlockchainSynced(function () {
                    GetFirstJob(function () {
                        SetupBlockPolling();
                        SetupPeer();
                        StartStratumServer(function () {
                            OutputPoolInfo();
                            _this.emit('started');
                        });
                    });
                });
            });
        });
    };

    function GetFirstJob(finishedCallback) {

        GetBlockTemplate(function (error, result) {
            if (error) {
                logger.error('Error with getblocktemplate on creating first job, server cannot start');
                logger.debug('error = %s', error);
                return;
            }

            var portWarnings = [];

            var networkDiffAdjusted = options.initStats.difficulty;

            Object.keys(options.ports).forEach(function (port) {
                var portDiff = options.ports[port].diff;
                if (networkDiffAdjusted < portDiff)
                    portWarnings.push('port ' + port + ' w/ diff ' + portDiff);
            });

            //Only let the first fork show synced status or the log wil look flooded with it
            if (portWarnings.length > 0 && (!process.env.forkId || process.env.forkId === '0')) {
                var warnMessage = 'Network diff of ' + networkDiffAdjusted + ' is lower than '
                    + portWarnings.join(' and ');
                logger.warn(warnMessage);
            }

            finishedCallback();

        });
    }


    function OutputPoolInfo() {

        var startMessage = 'Stratum Pool Server Started for ' + options.coin.name +
            ' [' + options.coin.symbol.toUpperCase() + '] {' + options.coin.algorithm + '}';
        if (process.env.forkId && process.env.forkId !== '0') {
            logger.info(startMessage);
            return;
        }
        var infoLines = [startMessage,
            'Network Connected:\t' + (options.testnet ? 'Testnet' : 'Mainnet'),
            'Detected Reward Type:\t' + options.coin.reward,
            'Current Block Height:\t' + _this.jobManager.currentJob.rpcData.height,
            'Current Connect Peers:\t' + options.initStats.connections,
            'Current Block Diff:\t' + _this.jobManager.currentJob.difficulty * algos[options.coin.algorithm].multiplier,
            'Network Difficulty:\t' + options.initStats.difficulty,
            'Network Hash Rate:\t' + util.getReadableHashRateString(options.initStats.networkHashRate),
            'Stratum Port(s):\t' + _this.options.initStats.stratumPorts.join(', '),
            'Pool Fee Percent:\t' + _this.options.feePercent + '%'
        ];

        if (typeof options.blockRefreshInterval === "number" && options.blockRefreshInterval > 0)
            infoLines.push('Block polling every:\t' + options.blockRefreshInterval + ' ms');

        logger.info(infoLines.join('\n\t\t\t\t\t\t'));
    }


    function OnBlockchainSynced(syncedCallback) {

        var checkSynced = function (displayNotSynced) {
            _this.daemon.cmd('getblocktemplate', [{
                "capabilities": ["coinbasetxn", "workid", "coinbase/append"],
                "rules": ["segwit"]
            }], function (results) {
                var synced = results.every(function (r) {
                    return !r.error || r.error.code !== -10;
                });
                if (synced) {
                    syncedCallback();
                }
                else {
                    if (displayNotSynced) {
                        displayNotSynced()
                    }
                    setTimeout(checkSynced, 5000);

                    //Only let the first fork show synced status or the log wil look flooded with it
                    if (!process.env.forkId || process.env.forkId === '0') {
                        generateProgress();
                    }
                }

            });
        };
        checkSynced(function () {
            //Only let the first fork show synced status or the log wil look flooded with it
            if (!process.env.forkId || process.env.forkId === '0')
                logger.warn('Daemon is still syncing with network (download blockchain) - server will be started once synced');
        });


        var generateProgress = function () {

            _this.daemon.cmd('getinfo', [], function (results) {
                var blockCount = results.sort(function (a, b) {
                    return b.response.blocks - a.response.blocks;
                })[0].response.blocks;

                //get list of peers and their highest block height to compare to ours
                _this.daemon.cmd('getpeerinfo', [], function (results) {

                    var peers = results[0].response;
                    var totalBlocks = peers.sort(function (a, b) {
                        return b.startingheight - a.startingheight;
                    })[0].startingheight;

                    var percent = (blockCount / totalBlocks * 100).toFixed(2);
                    log.warn('Downloaded %s% of blockchain from % peers', percent, peers.length);
                });

            });
        };

    }


    function SetupApi() {
        if (typeof(options.api) !== 'object' || typeof(options.api.start) !== 'function') {
            return;
        } else {
            options.api.start(_this);
        }
    }


    function SetupPeer() {
        if (!options.p2p || !options.p2p.enabled) {
            return;
        }

        if (options.testnet && !options.coin.peerMagicTestnet) {
            logger.error('p2p cannot be enabled in testnet without peerMagicTestnet set in coin configuration');
            return;
        }
        else if (!options.coin.peerMagic) {
            logger.error('p2p cannot be enabled without peerMagic set in coin configuration');
            return;
        }

        _this.peer = new peer(options);
        _this.peer.on('connected', function () {
            logger.info('p2p connection successful');
        }).on('connectionRejected', function () {
            logger.error('p2p connection failed - likely incorrect p2p magic value');
        }).on('disconnected', function () {
            logger.warn('p2p peer node disconnected - attempting reconnection...');
        }).on('connectionFailed', function (e) {
            logger.warn('p2p connection failed - likely incorrect host or port');
        }).on('socketError', function (e) {
            logger.error('p2p had a socket error, err = %s', JSON.stringify(e));
        }).on('error', function (msg) {
            logger.warn('p2p had an error ' + msg);
        }).on('blockFound', function (hash) {
            _this.processBlockNotify(hash, 'p2p');
        });
    }


    function SetupVarDiff() {
        _this.varDiff = {};
        Object.keys(options.ports).forEach(function (port) {
            if (options.ports[port].varDiff)
                _this.setVarDiff(port, options.ports[port].varDiff);
        });
    }


    /*
    Coin daemons either use submitblock or getblocktemplate for submitting new blocks
     */
    function SubmitBlock(blockHex, callback) {

        var rpcCommand, rpcArgs;
        if (options.hasSubmitMethod) {
            rpcCommand = 'submitblock';
            rpcArgs = [blockHex];
        }
        else {
            rpcCommand = 'getblocktemplate';
            rpcArgs = [{'mode': 'submit', 'data': blockHex}]; // TODO: is mode submit even correct?
        }


        _this.daemon.cmd(rpcCommand,
            rpcArgs,
            function (results) {
                for (var i = 0; i < results.length; i++) {
                    var result = results[i];
                    logger.info("Response from submitblock: %s", JSON.stringify(result));
                    if (result.error) {
                        logger.info('rpc error with daemon instance %s when submitting block with %s, err = %s', result.instance.index, rpcCommand, result.error);
                        return;
                    }
                    else if (result.response === 'rejected') {
                        logger.error('Daemon instance %s rejected a supposedly valid block', result.instance.index);
                        return;
                    }
                }
                logger.warn('Submitted Block using %s successfully to daemon instance(s)', rpcCommand);
                callback();
            }
        );

    }


    function SetupRecipients() {
        var recipients = [];
        options.feePercent = 0;
        options.rewardRecipients = options.rewardRecipients || {};
        for (var r in options.rewardRecipients) {
            var percent = options.rewardRecipients[r];
            var rObj = {
                percent: percent / 100
            };
            try {
                if (r.length === 40)
                    rObj.script = util.miningKeyToScript(r);
                else
                    rObj.script = util.addressToScript(r);
                recipients.push(rObj);
                options.feePercent += percent;
            }
            catch (e) {
                logger.error('Error generating transaction output script for %s in rewardRecipients', r);
            }
        }
        if (recipients.length === 0) {
            logger.warn('No rewardRecipients have been setup which means no fees will be taken');
        }
        options.recipients = recipients;
    }

    function SetupJobManager() {

        _this.jobManager = new jobManager(options);

        _this.jobManager.on('newBlock', function (blockTemplate) {
            //Check if stratumServer has been initialized yet
            if (_this.stratumServer) {
                _this.stratumServer.broadcastMiningJobs(blockTemplate.getJobParams());
            }
        }).on('updatedBlock', function (blockTemplate) {
            //Check if stratumServer has been initialized yet
            if (_this.stratumServer) {
                let job = blockTemplate.getJobParams();
                job[8] = false;
                _this.stratumServer.broadcastMiningJobs(job);
            }
        }).on('share', function (shareData, blockHexInvalid, blockHex) {
            let isValidShare = !shareData.error;
            let isValidBlock = !!blockHex;
            let emitShare = function () {
                _this.emit('share', isValidShare, isValidBlock, shareData);
            };

            /*
            If we calculated that the block solution was found,
            before we emit the share, lets submit the block,
            then check if it was accepted using RPC getblock
            */
            if (!isValidBlock)
                emitShare();
            else {
                SubmitBlock(blockHex, function () {

                    CheckBlockAccepted(shareData.blockHash, blockHex, this._daemon, function (isAccepted, tx, height, value) {
                        isValidBlock = isAccepted;
                        shareData.txHash = tx;
                        emitShare();
                        _this.emit('block', options.coin.symbol, height, shareData.blockHash, tx, shareData.blockReward * 0.00000001, shareData.difficulty, shareData.worker);
                        GetBlockTemplate(function (error, result, foundNewBlock) {
                            if (foundNewBlock) {
                                logger.debug('Block notification via RPC after block submission');
                            }
                        });

                    });
                });
            }
        }).on('log', function (severity, message) {
            logger.info(message);
        });
    }


    function SetupDaemonInterface(finishedCallback) {

        if (!Array.isArray(options.daemons) || options.daemons.length < 1) {
            logger.error('No daemons have been configured - pool cannot start');
            return;
        }

        _this.daemon = new daemon.interface(options.daemons, logger);

        _this.daemon.once('online', function () {
            finishedCallback();
        }).on('connectionFailed', function (error) {
            logger.error('Failed to connect daemon(s): %s', JSON.stringify(error));
        }).on('error', function (message) {
            logger.error(message);
        });

        _this.daemon.init();
    }


    function DetectCoinData(finishedCallback) {

        var batchRpcCalls = [
            ['validateaddress', [options.address]],
            ['getdifficulty', []],
            ['getinfo', []],
            ['getmininginfo', []],
            ['submitblock', []]
        ];

        _this.daemon.batchCmd(batchRpcCalls, function (error, results) {
            if (error || !results) {
                logger.error('Could not start pool, error with init batch RPC call: %s', JSON.stringify(error));
                return;
            }

            var rpcResults = {};

            for (var i = 0; i < results.length; i++) {
                var rpcCall = batchRpcCalls[i][0];
                var r = results[i];
                rpcResults[rpcCall] = r.result || r.error;

                if (rpcCall !== 'submitblock' && (r.error || !r.result)) {
                    logger.error('Could not start pool, error with init RPC %s - %s', rpcCall, JSON.stringify(r.error));
                    return;
                }
            }

            if (!rpcResults.validateaddress.isvalid) {
                logger.error('Daemon reports address is not valid');
                return;
            }

            if (!options.coin.reward) {
                if (isNaN(rpcResults.getdifficulty) && 'proof-of-stake' in rpcResults.getdifficulty)
                    options.coin.reward = 'POS';
                else
                    options.coin.reward = 'POW';
            }


            /* POS coins must use the pubkey in coinbase transaction, and pubkey is
               only given if address is owned by wallet.*/
            if (options.coin.reward === 'POS' && typeof(rpcResults.validateaddress.pubkey) == 'undefined') {
                logger.error('The address provided is not from the daemon wallet - this is required for POS coins.');
                return;
            }

            options.poolAddressScript = (function () {
                switch (options.coin.reward) {
                    case 'POS':
                        return util.pubkeyToScript(rpcResults.validateaddress.pubkey);
                    case 'POW':
                        return util.addressToScript(rpcResults.validateaddress.address);
                }
            })();

            options.testnet = rpcResults.getinfo.testnet;
            options.protocolVersion = rpcResults.getinfo.protocolversion;

            options.initStats = {
                connections: rpcResults.getinfo.connections,
                difficulty: rpcResults.getinfo.difficulty * algos[options.coin.algorithm].multiplier,
                networkHashRate: rpcResults.getmininginfo.networkhashps
            };


            if (rpcResults.submitblock.message === 'Method not found') {
                options.hasSubmitMethod = false;
            }
            else if (rpcResults.submitblock.code === -1) {
                options.hasSubmitMethod = true;
            }
            else {
                logger.error('Could not detect block submission RPC method, %s', JSON.stringify(results));
                return;
            }

            finishedCallback();

        });
    }


    function StartStratumServer(finishedCallback) {
        _this.stratumServer = new stratum.Server(options, authorizeFn, logger);

        _this.stratumServer.on('started', function () {
            options.initStats.stratumPorts = Object.keys(options.ports);
            _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());
            finishedCallback();

        }).on('broadcastTimeout', function () {
            logger.info('No new blocks for %s seconds - updating transactions & rebroadcasting work', options.jobRebroadcastTimeout);

            GetBlockTemplate(function (error, rpcData, processedBlock) {
                if (error || processedBlock) return;
                _this.jobManager.updateCurrentJob(rpcData);
            });

        }).on('client.connected', function (client) {
            if (typeof(_this.varDiff[client.socket.localPort]) !== 'undefined') {
                _this.varDiff[client.socket.localPort].manageClient(client);
            }

            client.on('difficultyChanged', function (diff) {
                _this.emit('difficultyUpdate', client.workerName, diff);

            }).on('subscription', function (params, resultCallback) {

                var extraNonce = _this.jobManager.extraNonceCounter.next();
                var extraNonce2Size = _this.jobManager.extraNonce2Size;
                resultCallback(null,
                    extraNonce,
                    extraNonce2Size
                );

                if (typeof(options.ports[client.socket.localPort]) !== 'undefined' && options.ports[client.socket.localPort].diff) {
                    this.sendDifficulty(options.ports[client.socket.localPort].diff);
                } else {
                    this.sendDifficulty(8);
                }

                this.sendMiningJob(_this.jobManager.currentJob.getJobParams());

            }).on('submit', function (params, resultCallback) {
                logger.silly('mining.submit event, params = %s', JSON.stringify(params));
                var result = _this.jobManager.processShare(
                    params.jobId,
                    client.previousDifficulty,
                    client.difficulty,
                    client.extraNonce1,
                    params.extraNonce2,
                    params.nTime,
                    params.nonce,
                    client.remoteAddress,
                    client.socket.localPort,
                    params.name,logger
                );
                logger.silly('result from jobManager process share = %s', JSON.stringify(result));
                resultCallback(result.error, result.result ? true : null);

            }).on('malformedMessage', function (message) {
                logger.warn('Malformed message from %s : %s', client.getLabel(), message);

            }).on('socketError', function (err) {
                logger.warn('Socket error from %s : %s', client.getLabel(), JSON.stringify(err));

            }).on('socketTimeout', function (reason) {
                logger.info('Connected timed out for %s : %s',client.getLabel(), reason)

            }).on('socketDisconnect', function () {
                logger.info('Socket disconnected from ' + client.getLabel());

            }).on('kickedBannedIP', function (remainingBanTime) {
                //todo to string interpolation, i'm tired
                logger.info('Rejected incoming connection from ' + client.remoteAddress + ' banned for ' + remainingBanTime + ' more seconds');

            }).on('forgaveBannedIP', function () {
                //todo to string interpolation, i'm tired
                logger.info('Forgave banned IP ' + client.remoteAddress);

            }).on('unknownStratumMethod', function (fullMessage) {
                //todo to string interpolation, i'm tired
                logger.warn('Unknown stratum method from ' + client.getLabel() + ': ' + fullMessage.method);

            }).on('socketFlooded', function () {
                //todo to string interpolation, i'm tired
                logger.warn('Detected socket flooding from ' + client.getLabel());

            }).on('tcpProxyError', function (data) {
                //todo to string interpolation, i'm tired
                logger.error('Client IP detection failed, tcpProxyProtocol is enabled yet did not receive proxy protocol message, instead got data: ' + data);

            }).on('bootedBannedWorker', function () {
                //todo to string interpolation, i'm tired
                logger.warn('Booted worker ' + client.getLabel() + ' who was connected from an IP address that was just banned');

            }).on('triggerBan', function (reason) {
                //todo to string interpolation, i'm tired
                logger.warn('Banned triggered for ' + client.getLabel() + ': ' + reason);
                _this.emit('banIP', client.remoteAddress, client.workerName);
            });
        });
    }


    function SetupBlockPolling() {
        if (typeof options.blockRefreshInterval !== "number" || options.blockRefreshInterval <= 0) {
            logger.info('Block template polling has been disabled');
            return;
        }

        var pollingInterval = options.blockRefreshInterval;

        blockPollingIntervalId = setInterval(function () {
            GetBlockTemplate(function (error, result, foundNewBlock) {
                if (foundNewBlock) {
                    logger.info('Block notification via RPC polling');
                }
            });
        }, pollingInterval);
    }


    function GetBlockTemplate(callback) {
        _this.daemon.cmd('getblocktemplate',
            [{"capabilities": ["coinbasetxn", "workid", "coinbase/append"], "rules": ["segwit"]}],
            function (result) {
                if (result.error) {
                    logger.debug("result.error = %s", result);
                    //todo to string interpolation, i'm tired
                    logger.error('getblocktemplate call failed for daemon instance ' +
                        result.instance.index + ' with error ' + JSON.stringify(result.error));
                    callback(result.error);
                } else {
                    var processedNewBlock = _this.jobManager.processTemplate(result.response);
                    callback(null, result.response, processedNewBlock);
                    callback = function () {
                    };
                }
            }, true
        );
    }


    function CheckBlockAccepted(blockHash, blockHex, daemon, callback) {
        //setTimeout(function(){
        _this.daemon.cmd('getblock',
            [blockHash],
            function (results) {
                let validResults = results.filter(function (result) {
                    return result.response && (result.response.hash === blockHash)
                });

                if (validResults.length >= 1) {
                    callback(true, validResults[0].response.tx[0], validResults[0].response.height);
                }
                else {
                    callback(false);
                }
            }
        );
        //}, 500);
    }


    /**
     * This method is being called from the blockNotify so that when a new block is discovered by the daemon
     * We can inform our miners about the newly found block
     **/
    this.processBlockNotify = function (blockHash, sourceTrigger) {
        logger.info('Block notification via %s', sourceTrigger);
        if (typeof(_this.jobManager.currentJob) !== 'undefined' && blockHash !== _this.jobManager.currentJob.rpcData.previousblockhash) {
            GetBlockTemplate(function (error, result) {
                if (error) {
                    logger.error('Block notify error getting block template for %s', options.coin.name);
                }
            })
        }
    };


    this.relinquishMiners = function (filterFn, resultCback) {
        var origStratumClients = this.stratumServer.getStratumClients();

        var stratumClients = [];
        Object.keys(origStratumClients).forEach(function (subId) {
            stratumClients.push({subId: subId, client: origStratumClients[subId]});
        });
        //TODO: Think of a way to use API 8's async/await and promises to replace async lib
        async.filter(
            stratumClients,
            filterFn,
            function (clientsToRelinquish) {
                clientsToRelinquish.forEach(function (cObj) {
                    cObj.client.removeAllListeners();
                    _this.stratumServer.removeStratumClientBySubId(cObj.subId);
                });

                process.nextTick(function () {
                    resultCback(
                        clientsToRelinquish.map(
                            function (item) {
                                return item.client;
                            }
                        )
                    );
                });
            }
        );

    };


    this.attachMiners = function (miners) {
        miners.forEach(function (clientObj) {
            _this.stratumServer.manuallyAddStratumClient(clientObj);
        });
        _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());

    };


    this.getStratumServer = function () {
        return _this.stratumServer;
    };


    this.setVarDiff = function (port, varDiffConfig) {
        if (typeof(_this.varDiff[port]) != 'undefined') {
            _this.varDiff[port].removeAllListeners();
        }
        var varDiffInstance = new varDiff(port, varDiffConfig,logger);
        _this.varDiff[port] = varDiffInstance;
        _this.varDiff[port].on('newDifficulty', function (client, newDiff) {

            /* We request to set the newDiff @ the next difficulty retarget
             (which should happen when a new job comes in - AKA BLOCK) */
            client.enqueueNextDifficulty(newDiff);

            /*if (options.varDiff.mode === 'fast'){
                 //Send new difficulty, then force miner to use new diff by resending the
                 //current job parameters but with the "clean jobs" flag set to false
                 //so the miner doesn't restart work and submit duplicate shares
                client.sendDifficulty(newDiff);
                var job = _this.jobManager.currentJob.getJobParams();
                job[8] = false;
                client.sendMiningJob(job);
            }*/

        });
    };

};
pool.prototype.__proto__ = events.EventEmitter.prototype;
