import test from 'node:test';import assert from 'node:assert/strict';
const { chooseSharePort, ownedShareRoute }=await import('../lib/share-network.mjs');
test('never chooses the private workbench 443 or overwrites another service',()=>{
 const config={TCP:{443:{HTTPS:true}},Web:{'node.tail.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:4870'}}},'node.tail.ts.net:8443':{Handlers:{'/':{Proxy:'http://127.0.0.1:9999'}}}}};
 assert.equal(chooseSharePort(config,4873),10000);
 config.TCP[10000]={HTTPS:true};assert.equal(chooseSharePort(config,4873),null);
});
test('only claims a sole root route to its dedicated listener',()=>{
 const good={Web:{'node.tail.ts.net:8443':{Handlers:{'/':{Proxy:'http://127.0.0.1:4873'}}}}};
 assert.equal(ownedShareRoute(good,8443,4873),true);
 good.Web['node.tail.ts.net:8443'].Handlers['/other']={Proxy:'http://127.0.0.1:9999'};
 assert.equal(ownedShareRoute(good,8443,4873),false);
});
