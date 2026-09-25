// V3 · 线路规划
export function routePlan(stores,pendingStores=[]){
 const planned=[...(stores||[])].sort((a,b)=>Number(a.routeOrder)-Number(b.routeOrder));
 return {plannedStores:planned,pendingStores:pendingStores||[],routeOrder:planned.map(x=>x.storeId)};
}
