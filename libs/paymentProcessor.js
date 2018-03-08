var fs = require('fs');

var redis = require('redis');
var async = require('async');

var Stratum = require('stratum-pool');
var util = require('stratum-pool/lib/util.js');


const BigNumber = require('bignumber.js');

const loggerFactory = require('./logger.js');

module.exports = function () {
    let logger = loggerFactory.getLogger('PaymentProcessing', 'system');

    var poolConfigs = JSON.parse(process.env.pools);
    logger.info("Payment processor worker started");

    var enabledPools = [];

    Object.keys(poolConfigs).forEach(function (coin) {
        var poolOptions = poolConfigs[coin];
        if (poolOptions.paymentProcessing &&
            poolOptions.paymentProcessing.enabled) {
            enabledPools.push(coin);
            logger.info("Enabled %s for payment processing", coin)
        }
    });

    async.filter(enabledPools, function (coin, callback) {
        SetupForPool(poolConfigs[coin], function (setupResults) {
            logger.debug("Processing processor initialized. Setup results %s", setupResults);
            callback(null, setupResults);
        });
    }, function (err, coins) {
        if (err) {
            logger.error('Error processing enabled pools in the config') // TODO: ASYNC LIB was updated, need to report a better error
        } else {
            coins.forEach(function (coin) {

                var poolOptions = poolConfigs[coin];
                var processingConfig = poolOptions.paymentProcessing;

                logger.info('Payment processing setup to run every %s second(s) with daemon (%s@%s:%s) and redis (%s:%s)',
                    processingConfig.paymentInterval,
                    processingConfig.daemon.user,
                    processingConfig.daemon.host,
                    processingConfig.daemon.port,
                    poolOptions.redis.host,
                    poolOptions.redis.port);
            });
        }
    });
};


function SetupForPool(poolOptions, setupFinished) {
    var coin = poolOptions.coin.name;
    const logger = loggerFactory.getLogger('PaymentProcessor', coin);


    var processingConfig = poolOptions.paymentProcessing;


    var daemon = new Stratum.daemon.interface([processingConfig.daemon], loggerFactory.getLogger('CoinDaemon', coin));

    var redisClient = redis.createClient(poolOptions.redis.port, poolOptions.redis.host);

    var minPayment;

    const coinPrecision = 8;
    var paymentInterval;

    logger.debug('Validating address and balance');

    async.parallel([
        function (callback) {
            daemon.cmd('validateaddress', [poolOptions.address], function (result) {
                logger.silly('Validated %s address with result %s', poolOptions.address, JSON.stringify(result));
                if (result.error) {
                    logger.error('Error with payment processing daemon %s', JSON.stringify(result.error));
                    callback(true);
                }
                else if (!result.response || !result.response.ismine) {
                    logger.error('Daemon does not own pool address - payment processing can not be done with this daemon, %s'
                        , JSON.stringify(result.response));
                    callback(true);
                }
                else {
                    callback()
                }
            }, true);
        },
        function (callback) {
            daemon.cmd('getbalance', [], function (result) {
                var wasICaught = false;
                if (result.error) {
                    callback(true);
                    return;
                }
                try {
                    let minimumPayment = new BigNumber(processingConfig.minimumPayment);
                    logger.silly('minimumPayment = %s', minimumPayment.toString(10));
                    minPayment = minimumPayment;
                }
                catch (e) {
                    console.log(e);
                    logger.error('Error detecting number of satoshis in a coin, cannot do payment processing. Tried parsing: %s', JSON.stringify(result.data));
                    wasICaught = true;
                }
                finally {
                    if (wasICaught) {
                        callback(true);
                    } else {
                        callback();
                    }
                }

            }, true, true);
        }
    ], function (err) {
        if (err) {
            logger.error("There was error during payment processor setup %s", JSON.stringify(err));
            setupFinished(false);
            return;
        }
        paymentInterval = setInterval(function () {
            try {
                processPayments();
                logger.info("Set up to process payments every %s seconds", processingConfig.paymentInterval);
            } catch (e) {
                logger.error("There was error during payment processor setup %s", JSON.stringify(e));
                throw e;
            }
        }, processingConfig.paymentInterval * 1000);
        setTimeout(processPayments, 100);
        setupFinished(true);
    });


    /* Deal with numbers in smallest possible units (satoshis) as much as possible. This greatly helps with accuracy
       when rounding and whatnot. When we are storing numbers for only humans to see, store in whole coin units. */

    var processPayments = function () {

        var startPaymentProcess = Date.now();

        var timeSpentRPC = 0;
        var timeSpentRedis = 0;

        var startTimeRedis;
        var startTimeRPC;

        var startRedisTimer = function () {
            startTimeRedis = Date.now()
        };
        var endRedisTimer = function () {
            timeSpentRedis += Date.now() - startTimeRedis
        };

        var startRPCTimer = function () {
            startTimeRPC = Date.now();
        };
        var endRPCTimer = function () {
            timeSpentRPC += Date.now() - startTimeRedis
        };

        async.waterfall([

            /* Call redis to get an array of rounds - which are coinbase transactions and block heights from submitted
               blocks. */
            function (callback) {
                logger.debug("Calling redis for array of rounds");
                startRedisTimer();
                redisClient.multi([
                    ['hgetall', coin + ':balances'],
                    ['smembers', coin + ':blocksPending']
                ]).exec(function (error, results) {
                    logger.debug("Redis responsed: %s", JSON.stringify(results));
                    endRedisTimer();

                    if (error) {
                        logger.error('Could not get blocks from redis %s', JSON.stringify(error));
                        callback(true);
                        return;
                    }


                    var workers = {};
                    for (var w in results[0]) {
                        workers[w] = {balance: new BigNumber(results[0][w])};
                    }

                    var rounds = results[1].map(function (r) {
                        var details = r.split(':');
                        return {
                            blockHash: details[0],
                            txHash: details[1],
                            height: details[2],
                            serialized: r
                        };
                    });

                    logger.debug("Prepared info basic info about payments");
                    logger.silly("workers = %s", JSON.stringify(workers));
                    logger.silly("rounds = %s", JSON.stringify(rounds));
                    logger.debug("Workers count: %s Rounds: %", Object.keys(workers).length, rounds.length);
                    callback(null, workers, rounds);
                });
            },

            /* Does a batch rpc call to daemon with all the transaction hashes to see if they are confirmed yet.
               It also adds the block reward amount to the round object - which the daemon gives also gives us. */
            function (workers, rounds, callback) {
                logger.debug("Checking for confirmed rounds (blocks)");
                var batchRPCcommand = rounds.map(function (r) {
                    return ['gettransaction', [r.txHash]];
                });

                batchRPCcommand.push(['getaccount', [poolOptions.address]]);

                startRPCTimer();
                daemon.batchCmd(batchRPCcommand, function (error, txDetails) {
                    endRPCTimer();

                    if (error || !txDetails) {
                        logger.error('Check finished - daemon rpc error with batch gettransactions %s', JSON.stringify(error));
                        callback(true);
                        return;
                    }

                    var addressAccount;

                    txDetails.forEach(function (tx, i) {
                        if (i === txDetails.length - 1) {
                            //choose addressAccount as last output of generation transaction
                            //because there may masternodes payees and pool address should be last
                            //in zcoin its tx.address
                            addressAccount = tx.result || tx.address;
                            logger.warn("Could not decrypt address from tx (no tx.result or tx.address field) %s", JSON.stringify(tx));
                            return;
                        }

                        var round = rounds[i];

                        if (tx.error && tx.error.code === -5) {
                            logger.warn('Daemon reports invalid transaction: %s', round.txHash);
                            logger.debug('Filtering out round %s as kicked cause of invalid tx', round.height);
                            round.category = 'kicked';
                            return;
                        }
                        else if (!tx.result.details || (tx.result.details && tx.result.details.length === 0)) {
                            logger.warn('Daemon reports no details for transaction: %s');
                            logger.debug('Filtering out round %s as kicked cause of no details for transaction', round.height);
                            round.category = 'kicked';
                            return;
                        }
                        else if (tx.error || !tx.result) {
                            logger.error('Odd error with gettransaction %s. tx = %s', round.txHash, JSON.stringify(tx));
                            round.category = 'kicked';
                            return;
                        }

                        var generationTx = tx.result.details.filter(function (tx) {
                            return tx.address === poolOptions.address;
                        })[0];


                        if (!generationTx && tx.result.details.length === 1) {
                            generationTx = tx.result.details[0];
                        }

                        if (!generationTx) {
                            logger.error('Missing output details to pool address for transaction %s', round.txHash);
                            return;
                        }

                        round.category = generationTx.category;
                        if (round.category === 'generate') {
                            round.reward = generationTx.amount || generationTx.value;
                        }

                    });

                    var canDeleteShares = function (r) {
                        for (var i = 0; i < rounds.length; i++) {
                            var compareR = rounds[i];
                            if ((compareR.height === r.height)
                                && (compareR.category !== 'kicked')
                                && (compareR.category !== 'orphan')
                                && (compareR.serialized !== r.serialized)) {
                                return false;
                            }
                        }
                        return true;
                    };


                    //Filter out all rounds that are immature (not confirmed or orphaned yet)
                    rounds = rounds.filter(function (r) {
                        switch (r.category) {
                            case 'orphan':
                            case 'kicked':
                                r.canDeleteShares = canDeleteShares(r);
                            case 'generate':
                                return true;
                            default:
                                return false;
                        }
                    });


                    logger.silly("Wokers and rounds after filtering orphans etc.");
                    logger.silly("workers = %s", JSON.stringify(workers));
                    logger.silly("rounds = %s", JSON.stringify(rounds));
                    callback(null, workers, rounds, addressAccount);

                });
            },


            /* Does a batch redis call to get shares contributed to each round. Then calculates the reward
               amount owned to each miner for each round. */
            function (workers, rounds, addressAccount, callback) {
                logger.debug("Getting all shares for rounds and calculating rewards for miners");
                var shareLookups = rounds.map(function (r) {
                    return ['hgetall', coin + ':shares:round' + r.height]
                });

                logger.silly('Calling redis for %s', JSON.stringify(shareLookups));

                startRedisTimer();
                redisClient.multi(shareLookups).exec(function (error, allWorkerShares) {
                    endRedisTimer();
                    logger.silly('Response from redis allWorkerShares = %s', JSON.stringify(allWorkerShares));
                    if (error) {
                        callback('Check finished - redis error with multi get rounds share');
                        return;
                    }

                    logger.silly('allWorkerShares before merging %s', JSON.stringify(allWorkerShares));

                    logger.debug("Mapping workers into payout addresses");
                    // This snippet will parse all workers and merge different workers into 1 payout address
                    allWorkerShares = allWorkerShares.map((roundShare) => {
                        let resultForRound = {};
                        logger.debug("roundShare = %s", roundShare);

                        Object.keys(roundShare).forEach((workerStr) => {
                            logger.debug("Iterating worker %s", workerStr);
                            //test workername is not null (those may be if miner mine on stratum without user and worker)
                            if (workerStr) {
                                if (workerStr.indexOf(".") !== -1) {
                                    //we have address and worker
                                    logger.silly("%s worker have both payout address and worker, merging", workerStr);
                                    let workerInfo = workerStr.split('.');
                                    if (workerInfo.length === 2) {
                                        //todo validate by daemon
                                        let address = workerInfo[0];
                                        if (resultForRound[address]) {
                                            logger.silly("Already have balance for address %s : %s", address, resultForRound[address].toString(10));
                                            resultForRound[address] = resultForRound[address].plus(roundShare[workerStr]);
                                            logger.silly("New balance %s ", resultForRound[address].toString(10));
                                        } else {
                                            resultForRound[address] = new BigNumber(roundShare[workerStr]);
                                        }
                                    }
                                } else {
                                    //todo validate by daemon
                                    let address = workerStr;
                                    if (resultForRound[address]) {
                                        logger.silly("Already have balance for address %s : %s", address, resultForRound[address].toString(10));
                                        resultForRound[address] = resultForRound[address].plus(roundShare[workerStr]);
                                        logger.silly("New balance %s ", resultForRound[address].toString(10));
                                    } else {
                                        resultForRound[address] = new BigNumber(roundShare[workerStr]);
                                    }
                                }
                            } else {
                                logger.error('Look around! We have anonymous shares, null worker');
                            }
                        });
                        return resultForRound;
                    });

                    logger.debug('Merged workers into payout addresses');
                    logger.silly('allWorkerShares after merging %s', JSON.stringify(allWorkerShares));


                    rounds.forEach(function (round, i) {
                        logger.silly('iterating round #%s from allWorkerShares', i);
                        logger.silly('round = %s', JSON.stringify(round));

                        var workerSharesForRound = allWorkerShares[i];
                        logger.silly('workerSharesForRound = %s', JSON.stringify(workerSharesForRound));
                        if (!workerSharesForRound) {
                            logger.error('No worker shares for round: %s, blockHash %s', round.height, round.blockHash);
                            return;
                        }

                        switch (round.category) {
                            case 'kicked':
                            case 'orphan':
                                logger.warn("Round with height %s and tx %s is orphan", round.height, round.txHash);
                                round.workerShares = workerSharesForRound;
                                break;

                            case 'generate':
                                /* We found a confirmed block! Now get the reward for it and calculate how much
                                   we owe each miner based on the shares they submitted during that block round. */
                                logger.info("We have found confirmed block #%s ready for payout", round.height);
                                logger.silly("round.reward = %s", round.reward);
                                var reward = new BigNumber(round.reward);
                                logger.silly("reward = %s", reward.toString(10));

                                var totalShares = Object.keys(workerSharesForRound).reduce(function (p, c) {
                                    if (p === 0) {
                                        p = new BigNumber(0)
                                    }
                                    return p.plus(workerSharesForRound[c])
                                }, 0);
                                logger.silly('totalShares = %s', totalShares.toString(10));

                                Object.keys(workerSharesForRound).forEach((workerAddress) => {
                                    logger.debug("Calculating reward for workerAddress %s", workerAddress);
                                    let percent = workerSharesForRound[workerAddress].dividedBy(totalShares);
                                    logger.silly("percent = %s", percent.toString(10));
                                    let workerRewardTotal = reward.multipliedBy(percent);
                                    logger.silly("workerRewardTotal = %s", workerRewardTotal.toString(10));
                                    let worker = workers[workerAddress] = (workers[workerAddress] || {});
                                    logger.silly("worker = %s", JSON.stringify(worker));
                                    worker.reward = (worker.reward || new BigNumber(0)).plus(workerRewardTotal);
                                    logger.silly('worker.reward = %s', worker.reward.toString(10));
                                });

                                break;
                        }
                    });

                    callback(null, workers, rounds, addressAccount);
                });
            },


            /* Calculate if any payments are ready to be sent and trigger them sending
             Get balance different for each address and pass it along as object of latest balances such as
             {worker1: balance1, worker2, balance2}
             when deciding the sent balance, it the difference should be -1*amount they had in db,
             if not sending the balance, the differnce should be +(the amount they earned this round)
             */
            function (workers, rounds, addressAccount, callback) {
                logger.debug("Almost ready to send funds, calculating against existing balances");
                var trySend = function (withholdPercent) {
                    logger.debug('Trying to send');
                    logger.silly('withholdPercent = %s', withholdPercent.toString(10));
                    var addressAmounts = {};
                    var totalSent = new BigNumber(0);
                    logger.silly('totalSent = %s', totalSent);
                    for (var w in workers) {
                        logger.silly('w = %s', w);
                        var worker = workers[w];
                        logger.silly('worker = %s', JSON.stringify(worker));
                        worker.balance = worker.balance || new BigNumber(0);
                        logger.silly('worker.balance = %s', worker.balance.toString(10));
                        worker.reward = worker.reward || new BigNumber(0);
                        logger.silly('worker.reward = %s', worker.reward.toString(10));
                        var toSend = (worker.balance.plus(worker.reward)).multipliedBy(new BigNumber(1).minus(withholdPercent));
                        logger.silly('toSend = %s', toSend.toString(10));
                        if (toSend.isGreaterThanOrEqualTo(minPayment)) {
                            logger.info('Worker %s have reached minimum payout threshold (%s above minimum %s)', w, toSend.toString(10), minPayment.toString(10));
                            totalSent = totalSent.plus(toSend);
                            logger.silly('totalSent = %s', totalSent.toString(10));
                            var address = worker.address = (worker.address || getProperAddress(w));
                            logger.silly('address = %s', address);
                            worker.sent = addressAmounts[address] = toSend;
                            logger.silly('worker.sent = %s', worker.sent.toString(10));
                            worker.balanceChange = BigNumber.min(worker.balance, worker.sent).multipliedBy(new BigNumber(-1));
                            logger.silly('worker.balanceChange = %s', worker.balanceChange.toString(10));
                        }
                        else {
                            logger.debug('Worker %s have not reached minimum payout threshold %s', w, minPayment.toString(10));
                            worker.balanceChange = BigNumber.max(toSend.minus(worker.balance), new BigNumber(0));
                            logger.silly('worker.balanceChange = %s', worker.balanceChange.toString(10));
                            worker.sent = new BigNumber(0);
                            logger.silly('worker.sent = %s', worker.sent.toString(10));
                        }
                    }

                    if (Object.keys(addressAmounts).length === 0) {
                        logger.info('No workers was chosen for paying out');
                        callback(null, workers, rounds);
                        return;
                    }

                    logger.info('Payments to miners: %s', JSON.stringify(addressAmounts));

                    Object.keys(addressAmounts).forEach((address) => {
                        addressAmounts[address] = new BigNumber(addressAmounts[address].toFixed(coinPrecision, 1)).toNumber();
                    });

                    logger.info('Ok, going to pay from "%s" address with final amounts: %s', addressAccount, JSON.stringify(addressAmounts));
                    daemon.cmd('sendmany', [addressAccount || '', addressAmounts], function (result) {
                        //Check if payments failed because wallet doesn't have enough coins to pay for tx fees
                        if (result.error && result.error.code === -6) {
                            var higherPercent = withholdPercent.plus(new BigNumber(0.01));
                            logger.warn('Not enough funds to cover the tx fees for sending out payments, decreasing rewards by %s% and retrying');
                            trySend(higherPercent);
                        }
                        else if (result.error) {
                            logger.error('Error trying to send payments with RPC sendmany %s', JSON.stringify(result.error));
                            callback(true);
                        }
                        else {
                            logger.debug('Sent out a total of ' + (totalSent)
                                + ' to ' + Object.keys(addressAmounts).length + ' workers');
                            if (withholdPercent.isGreaterThan(new BigNumber(0))) {
                                logger.warn('Had to withhold ' + (withholdPercent * new BigNumber(100)).toString(10)
                                    + '% of reward from miners to cover transaction fees. '
                                    + 'Fund pool wallet with coins to prevent this from happening');
                            }
                            callback(null, workers, rounds);
                        }
                    }, true, true);
                };
                trySend(new BigNumber(0));

            },
            function (workers, rounds, callback) {

                var totalPaid = new BigNumber(0);

                var balanceUpdateCommands = [];
                var workerPayoutsCommand = [];

                for (var w in workers) {
                    var worker = workers[w];
                    if (!worker.balanceChange.eq(new BigNumber(0))) {
                        balanceUpdateCommands.push([
                            'hincrbyfloat',
                            coin + ':balances',
                            w,
                            worker.balanceChange.toFixed(coinPrecision).toString(10)
                        ]);
                    }
                    if (worker.sent !== 0) {
                        workerPayoutsCommand.push(['hincrbyfloat', coin + ':payouts', w, worker.sent.toString(10)]);
                        totalPaid = totalPaid.plus(worker.sent);
                    }
                }


                var movePendingCommands = [];
                var roundsToDelete = [];
                var orphanMergeCommands = [];

                var moveSharesToCurrent = function (r) {
                    var workerShares = r.workerShares;
                    Object.keys(workerShares).forEach(function (worker) {
                        orphanMergeCommands.push(['hincrby', coin + ':shares:roundCurrent',
                            worker, workerShares[worker].toFixed(coinPrecision).toString()]);
                    });
                };

                rounds.forEach(function (r) {

                    switch (r.category) {
                        case 'kicked':
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksKicked', r.serialized]);
                        case 'orphan':
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksOrphaned', r.serialized]);
                            if (r.canDeleteShares) {
                                moveSharesToCurrent(r);
                                roundsToDelete.push(coin + ':shares:round' + r.height);
                            }
                            return;
                        case 'generate':
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksConfirmed', r.serialized]);
                            roundsToDelete.push(coin + ':shares:round' + r.height);
                            return;
                    }

                });

                var finalRedisCommands = [];

                logger.silly("finalRedisCommands %s", finalRedisCommands);
                if (movePendingCommands.length > 0) {
                    logger.silly("movePendingCommands goes in redis");
                    logger.silly("movePendingCommands = %s", movePendingCommands);
                    finalRedisCommands = finalRedisCommands.concat(movePendingCommands);
                }
                if (orphanMergeCommands.length > 0) {
                    logger.silly("orphanMergeCommands goes in redis");
                    logger.silly("orphanMergeCommands = %s", orphanMergeCommands);
                    finalRedisCommands = finalRedisCommands.concat(orphanMergeCommands);
                }

                if (balanceUpdateCommands.length > 0) {
                    logger.silly("balanceUpdateCommands goes in redis");
                    logger.silly("balanceUpdateCommands = %s", balanceUpdateCommands);
                    finalRedisCommands = finalRedisCommands.concat(balanceUpdateCommands);
                }
                if (workerPayoutsCommand.length > 0) {
                    logger.silly("workerPayoutsCommand goes in redis");
                    logger.silly("workerPayoutsCommand = %s", workerPayoutsCommand);
                    finalRedisCommands = finalRedisCommands.concat(workerPayoutsCommand);
                }

                if (roundsToDelete.length > 0) {
                    logger.silly("roundsToDelete goes in redis");
                    logger.silly("roundsToDelete = %s", roundsToDelete);
                    finalRedisCommands.push(['del'].concat(roundsToDelete));
                }

                if (!totalPaid.eq(new BigNumber(0))) {
                    logger.silly("totalPaid goes in redis");
                    logger.silly("totalPaid = %s", totalPaid);
                    finalRedisCommands.push(['hincrbyfloat', coin + ':stats', 'totalPaid', totalPaid.toFixed(coinPrecision).toString()]);
                }

                if (finalRedisCommands.length === 0) {
                    logger.silly("Nothing to write to redis");
                    callback();
                    return;
                }
                logger.silly("finalRedisCommands %s", finalRedisCommands);

                startRedisTimer();
                redisClient.multi(finalRedisCommands).exec(function (error, results) {
                    endRedisTimer();
                    if (error) {
                        clearInterval(paymentInterval);
                        logger.error('Payments sent but could not update redis. Disabling payment processing to prevent possible double-payouts.' +
                            ' %s The redis commands in %s_finalRedisCommands.txt must be ran manually', JSON.stringify(error), coin);
                        fs.writeFile(coin + '_finalRedisCommands_' + new Date().getTime() + '.txt`', JSON.stringify(finalRedisCommands), function (err) {
                            logger.error('Could not write finalRedisCommands.txt, you are fucked.');
                        });
                    }
                    logger.debug("Redis have sucessfully updated after payouts");
                    callback();
                });
            }

        ], function () {


            var paymentProcessTime = Date.now() - startPaymentProcess;
            logger.debug('Finished interval - time spent: %s ms total, %s ms redis, %s ms daemon RPC',
                paymentProcessTime,
                timeSpentRedis,
                timeSpentRPC);
        });
    };


    var getProperAddress = function (address) {
        if (address.length === 40) {
            return util.addressFromEx(poolOptions.address, address);
        }
        else return address;
    };


}