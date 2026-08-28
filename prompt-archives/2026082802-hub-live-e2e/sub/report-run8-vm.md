# tmex split hub-e2e report

- date: 2026-08-28T17:09:57Z
- image: tmex-e2e:split
- tarball: /Users/konata/code/tmex-enhanced-wt-merge/scripts/hub-e2e/build/tmex-cli.tgz
- hub: https://hub.tmex.test:18443
- hub host/ip: hub.tmex.test / 118.195.194.170
- tls: private-ca
- remote: ubuntu@118.195.194.170:/home/ubuntu/tmex-e2e

| scenario | result | evidence |
|---|---|---|
| A0 hub /healthz via public HTTPS | PASS |  |
| A0b hub user add alice | PASS |  |
| A0c /api/auth/mode mesh fields | PASS |  |
| A1 enroll+join node-a and node-b over internet | PASS |  |
| A2 login hub entry https://hub.tmex.test:18443 | PASS |  |
| A3 /api/hub/nodes both online | PASS |  |
| A4 resolve node ids | PASS |  |
| A5 login node-a via hub | PASS |  |
| A6 create local device on node-a | PASS |  |
| A7 terminal marker round-trip on node-a through hub (relay) | PASS |  |
| A5b login node-b via hub | PASS |  |
| A8 files list+read on node-b through hub | PASS |  |
| B1 login node-a entry | PASS |  |
| B2 node-a mesh lists hub isHub:true ce6a6ece6deeb78a9626b3b9f80b2ab1 | PASS |  |
| B3 login remote hub node via node-a | PASS |  |
| B4 create local device on hub container | PASS |  |
| B5 tmux tree on hub via node-a | PASS |  |
| B6 terminal marker node-a → remote hub node (reach=relay) | PASS |  |
| C1 node-a sees node-b reach=lan within 90s | PASS |  |
| C2 terminal marker via LAN | PASS |  |
| C3 terminal marker with remote hub down | PASS |  |
| C4 file list with remote hub down | PASS |  |
| C5 /api/mesh/nodes still lists node-b | PASS |  |
| C6 both nodes online on hub within 120s | PASS |  |
| C7 existing hub cookies still valid | PASS |  |
| E1 docker restart node-a re-uplinks, app.env intact | PASS |  |
| E2 node-a still reaches hub node after restart | PASS |  |
| E3 remote hub restart, nodes reconnect, no ghost rows | PASS |  |
| L1 both rows direct_capable=true | PASS | {"reach":"lan","transport":"dc","direct_capable":true} |
| L2 transport=dc | PASS | {"reach":"lan","transport":"dc","direct_capable":true} |
| L3 marker round-trip while transport=dc | PASS | {"reach":"lan","transport":"dc","direct_capable":true} |
| L4 transport falls back to ws-secure within 30s | PASS | mode=iptables drop_rc=0 |
| L5 SEQ_1..400 contiguous on entry stream | PASS | {"ok":true,"expectCount":400,"seqPrefix":"SEQ_","foundCount":400,"fromHistory":400,"fromOutput":151,"first":1,"last":400,"missing":[],"missingCount":0,"extra":[],"contiguous":true,"complete":true,"opened":true,"helloOk":true,"connected":true,"elapsedMs":29151}  |
| L6 transport returns to dc within 90s | PASS | {"reach":"lan","transport":"dc","direct_capable":true} |
| L7 8MiB sha256 over dc | PASS | sha256=372cade5e3b951eac5bfd4d5d8db4210b6a05bc2ff0d9686b690063b137f3840 {"bytes":8388608,"headers":{"content-type":"application/octet-stream"},"bulkPath":"browser-only"}; bulk DataChannel is browser-only (BulkClient bulk:<id>), REST /api/files/raw rides the mesh link |
| L8 8MiB sha256 with UDP drop (REST fallback) | FAIL | relay_wait=1 expect=372cade5e3b951eac5bfd4d5d8db4210b6a05bc2ff0d9686b690063b137f3840 got=  |
| D1 both rows direct_capable=true | PASS | {"reach":"lan","transport":"dc","direct_capable":true} |
| D2 transport=dc | PASS | {"reach":"lan","transport":"dc","direct_capable":true} |
| D3 marker round-trip while transport=dc | PASS | {"reach":"lan","transport":"dc","direct_capable":true} |
| H1 transport falls back to relay within 30s | PASS | mode=iptables drop_rc=0 |
| H2 SEQ_1..400 contiguous on entry stream | PASS | {"ok":true,"expectCount":400,"seqPrefix":"SEQ_","foundCount":400,"fromHistory":400,"fromOutput":157,"first":1,"last":400,"missing":[],"missingCount":0,"extra":[],"contiguous":true,"complete":true,"opened":true,"helloOk":true,"connected":true,"elapsedMs":32412}  |
| H3 transport returns to dc within 90s | PASS | {"reach":"lan","transport":"dc","direct_capable":true} |
| I1 8MiB sha256 over dc | FAIL | expect=871bf018d0d919bf7f4b6a9d8ab9172a9fa90675e3487e546f222cd8216815f7 got= root_rc=0  |
| I2 8MiB sha256 with UDP drop (REST fallback) | FAIL | relay_wait=1 expect=871bf018d0d919bf7f4b6a9d8ab9172a9fa90675e3487e546f222cd8216815f7 got=  |
| F Playwright login + sidebar + terminal + passkey (see /Users/konata/code/tmex-enhanced-wt-merge/scripts/hub-e2e/split/out/f-browser.json) | FAIL | F Playwright login + sidebar + terminal + passkey (see /Users/konata/code/tmex-enhanced-wt-merge/scripts/hub-e2e/split/out/f-browser.json) |
| G node-b unreachable after revoke | PASS |  |
