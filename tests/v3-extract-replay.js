// V3 · 门店提取回放测试样本（纯函数，不访问数据库）
import { extractStores } from '../functions/api/v3/extract.js';

const A = \`江北亿达鲜观府国际店（客百年） -> 江北亿达鲜半山华府店（客百年） -> 天友加盟农垦大厦店 -> 江北重庆全嘉食品供应链科技有限公司（救助管
理站） -> 江北JM03115-谊品生鲜重庆御龙天峰店 -> 天友24h重庆海浚酒店管理有限公司 -> 渝北JM03050谊品生鲜温馨家园南门店 -> 天友加盟韩志贤加盟重庆彭成商贸有限公司 -> II类天友生活花卉东路店 -> 江北JM03022谊品生鲜重庆北国风光店 -> 渝北钱大妈重庆东和春天店 -> 江北胡汪洋经销商（重庆胡建镜好食品有限公司） -> 江北A02175谊品生鲜锦绣北滨路店 -> 江北钱大妈半山华府店 -> 江北Q312重庆沁园餐饮管理有限公司松石北路店 -> 渝北Q044重庆沁园餐饮管理有限公司加州龙华小吃店
总数量16
总重量1.234t\`;

const B = \`渝北A02230谊品生鲜温馨家园南门店 -> 到家主城 - 江北区鸿恩寺客服中心（2026） -> 到家主城 - 江北区加州客服中心（2026） -> 江北亿达鲜半山华府店（客百年） -> 天友加盟农垦大厦店 -> 江北重庆全嘉食品供应链科技有限公司（救助管理站） -> 江北JM03115-谊品生鲜重庆御龙天峰店 -> 天友加盟韩志贤加盟重庆彭成商贸有限公司 -> II类天友生活花卉东路店 -> 江北JM03022谊品生鲜重庆北国风光店 -> 渝北钱大妈重庆东和春天店 -> 江北重庆彩食鲜供应链发展有限公司（重庆中法供水有限公司花园新村） -> 江北胡汪洋经销商（重庆胡建镜好食品有限公司） -> 江北A02175谊品生鲜锦绣北滨路店 -> 江北钱大妈半山华府店
总数量15
总重量0.9t\`;

function assert(n,v){if(n!==v)throw new Error('expected '+v+', got '+n);}
const a=extractStores(A),b=extractStores(B);
assert(a.length,16); assert(b.length,15);
assert(a.some(x=>x.includes('救助管理站')),true);
assert(a.some(x=>x.includes('JM03115')),true);
assert(a.some(x=>x.includes('Q312')),true);
assert(b.some(x=>x.includes('鸿恩寺客服中心')),true);
assert(b.some(x=>x.includes('加州客服中心')),true);
assert(b.some(x=>x.includes('A02230')),true);
console.log('V3 extraction replay PASS: A=16, B=15');
