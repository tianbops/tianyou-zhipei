// Tianyou ZhipeiOne V3 core
export function v3RedisKey(...parts){return ['v3',...parts.map(v=>encodeURIComponent(String(v??'')))].join(':');}
