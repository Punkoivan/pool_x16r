### We are trying to reborn NOMP. Need contributors!
-------
# Lyra2z (Zcoin) algo fixed, next step is neoscrypt

-------
### Node Open Mining Portal consists from 3 main modules:
* Main module - https://github.com/foxer666/node-open-mining-portal
* Stratum Pool - https://github.com/foxer666/node-stratum-pool
* Node Multihashing libraries https://github.com/foxer666/node-multi-hashing

Stratum Pool can be replaced with node-merged-pool (it's made in UNOMP)
Adding new algos threw Node Multihashing libraries.

Current version: v1.0.7

-------
### Install
```
git clone https://github.com/foxer666/node-open-mining-portal.git pool
cd pool
npm install
node init.js
```
-------
### Requirements
* Node 8.x.x or higher
* Coin daemon
* Redis Server

### Run in Docker

1) Correct configs appropriately to your environment in docker directory
2) ```cd docker```
3) ```docker build -t nomp .```
4) ```docker run -d --name nomp -v $(pwd)/config:/opt/config nomp ```

You will need to expose some ports to make it accessible from outside. You can achieve this by adding option -p HOST_PORT:CONTAINER_PORT in 4th step

You can see the logs of the server with ```docker logs -f nomp```, or jump into container with ```docker exec -it nomp```.

-------
### Hashing algorithms
#### Working
|   | Algorithm | Comment|
| ------------- | ------------- | ------------- |
| ✓ | __Groestl__ | tested only shares with AuroraCoin, blocks not tested |
| ✓ | __lyra2z__ | Working in testnet *mining* and *payouts* |
| ✓ | __Scrypt__ | tested with AntiLiteCoin, 1CREDIT, ArgusCoin, WAYAWOLFCOIN and many others |
| ✓ | __SHA256__ | tested with VCOIN, don't use with BTC, no Segwit tested |
| ✓ | __X11__ | tested with BrainCoin, CannabisCoin, AdzCoin and many others |
| ✓ | __X16r__ | tested with RavenCoin |

#### Need tests
|   | Algorithm | Comment|
| ------------- | ------------- | ------------- |
| ? | __Argon2__ | need tests |
| ? | __Blake__ | need tests |
| ? | __Blake2S__ | need tests |
| ? | __Cryptonight__ | need tests |
| ? | __Dcrypt__ | need tests |
| ? | __Decred__ | need tests |
| ? | __Fresh__ | need tests |
| ? | __Fugue__ | need tests |
| ? | __GroestlMyriad__ | need tests |
| ? | __Qubit__ | Shares works, blocks finding, but error 'We thought a block was found but it was rejected by the daemon'. No blocks presented in pools web interface |
| ? | __Quark__ | need tests |
| ? | __Hefty1__ | need tests |
| ? | __Keccak__ | need tests |
| ? | __Lbry__ | need tests |
| ? | __lyra2re__ | need tests |
| ? | __lyra2re2__ | need tests |
| ? | __lyra2rev2__ | need tests |
| ? | __lyra2z330__ | need tests |
| ? | __NeoScrypt__ | working on it |
| ? | __NIST5__ | need tests |
| ? | __S3__ | need tests |
| ? | __Scrypt-N__ | need tests |
| ? | __Scrypt-OG__ | need tests |
| ? | __Sha1__ | need tests |
| ? | __SHAvite-3__ | need tests |
| ? | __Skein__ | need tests |
| ? | __X11Ghost__ | need tests |
| ? | __X13__ | need tests |
| ? | __X14__ | need tests |
| ? | __X15__ | need tests |
| ? | __Yescrypt__ | need tests |
| ? | __zr5__ | need tests |
| ? | __ziftr__ | need tests |

#### Don't work yet
|   | Algorithm | Comment|
| ------------- | ------------- | ------------- |
| - | __Scrypt-Jane__ | submitblock not working tested with CacheCoin, Yacoin |

-------
### Notes
#### Lyra2Z
If you are going to test ZCoin (lyra2z) on testnet, make sure you are uncommented proper lines in transactions.js in https://github.com/foxer666/node-stratum-pool 

There is a ```payment-fixes``` branch where i fixed previous blockHash problem and corrected payouts. Check it out in this and stratum server module.

-------
### Credits
* [a2hill](//github.com/a2hill) - helped with X16r
* [devnulled](//github.com/devnull-ed) - helped with lyra2z, neoscrypt algo
* [Kris Klosterman / krisklosterman](https://github.com/krisklosterman) - Updated code for work wiht Node.JS >=8
* [Jerry Brady / mintyfresh68](https://github.com/bluecircle) - got coin-switching fully working and developed proxy-per-algo feature
* [Tony Dobbs](http://anthonydobbs.com) - designs for front-end and created the NOMP logo
* [LucasJones](//github.com/LucasJones) - got p2p block notify working and implemented additional hashing algos
* [vekexasia](//github.com/vekexasia) - co-developer & great tester
* [TheSeven](//github.com/TheSeven) - answering an absurd amount of my questions and being a very helpful gentleman
* [UdjinM6](//github.com/UdjinM6) - helped implement fee withdrawal in payment processing
* [Alex Petrov / sysmanalex](https://github.com/sysmanalex) - contributed the pure C block notify script
* [svirusxxx](//github.com/svirusxxx) - sponsored development of MPOS mode
* [icecube45](//github.com/icecube45) - helping out with the repo wiki
* [Fcases](//github.com/Fcases) - ordered me a pizza <3
* Those that contributed to [node-stratum-pool](//github.com/zone117x/node-stratum-pool#credits)

-------
### License
Released under the GNU General Public License v2
http://www.gnu.org/licenses/gpl-2.0.html
