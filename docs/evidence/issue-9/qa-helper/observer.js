let latest;
async function poll() {
 const [tabs,groups] = await Promise.all([chrome.tabs.query({}),chrome.tabGroups.query({})]);
 latest = {at:new Date().toISOString(),ua:navigator.userAgent,activeGroupCount:groups.length,groups,tabs:tabs.map(({id,windowId,groupId,pinned,title,url})=>({id,windowId,groupId,pinned,title,url}))};
 document.querySelector('#current').textContent=JSON.stringify(latest,null,2);
}
document.querySelector('#record').addEventListener('click',()=>{document.querySelector('#log').textContent+=JSON.stringify(latest)+String.fromCharCode(10);});
poll(); setInterval(poll,1000);
