import config from "../constant.js";

const ARGS = {
  // filePathKey: "filePath",
  // notLocalKey: "notLocal",
  skipRouteKey: "skipRoute",
  useProxyKey: "useProxy",
  useRedirectKey: "useRedirect",
  internalKey: "internal",
  cacheLevleKey: "cacheLevel",
}

const ROUTE_ENUM = {
  proxy: "proxy",
  redirect: "redirect",
  transcode: "transcode",
  block: "block",
};

const CHCHE_LEVEL_ENUM = {
  L1: "L1",
  L2: "L2",
  // L3: "L3",
};

function proxyUri(uri) {
  return `/proxy${uri}`;
}

function appendUrlArg(u, k, v) {
  if (u.includes(k)) {
    return u;
  }
  return u + (u.includes("?") ? "&" : "?") + `${k}=${v}`;
}

function addDefaultApiKey(r, u) {
  let url = u;
  const itemInfo = getItemInfo(r);
  if (!url.includes("api_key") && !url.includes("X-Emby-Token")) {
    url = appendUrlArg(url, "api_key", itemInfo.api_key);
  }
  return url;
}

function generateUrl(r, host, uri, skipKeys) {
  skipKeys = skipKeys ?? [];
  let url = host + uri;
  let isFirst = true;
  for (const key in r.args) {
    if (skipKeys.includes(key)) {
      continue;
    }
    url += isFirst ? "?" : "&";
    url += `${key}=${r.args[key]}`;
    isFirst = false;
  }
  return url;
}

function getCurrentRequestUrl(r) {
  return addDefaultApiKey(r, generateUrl(r, getCurrentRequestUrlPrefix(r), r.uri));
}

function getCurrentRequestUrlPrefix(r) {
  return `${r.variables.scheme}://${r.headersIn["Host"]}`;
}

function copyHeaders(sourceHeaders, targetHeaders, skipKeys) {
  if (!skipKeys) {
    // auto generate content length
    skipKeys = ["Content-Length"];
  }
  for (const key in sourceHeaders) {
	  if (skipKeys.includes(key)) {
	    continue;
	  }
	  targetHeaders[key] = sourceHeaders[key];
	}
}

function groupBy(array, key) {
  return array.reduce((result, currentItem) => {
    const groupKey = typeof key === 'function' ? key(currentItem) : currentItem[key];
    if (!result[groupKey]) {
      result[groupKey] = [];
    }
    result[groupKey].push(currentItem);
    return result;
  }, {});
};

/**
 * getRouteMode
 * @param {Object} r nginx objects, HTTP Request
 * @param {String} filePath mediaFilePath or alistRes link
 * @param {Boolean} isAlistRes alistRes link
 * @param {Boolean} notLocal if not need proxy route can be undefined
 * @returns ROUTE_ENUM.xxx
 */
function getRouteMode(r, filePath, isAlistRes, notLocal) {
  let cRouteRule = config.routeRule;
  // skip internal request
  if (r.args[ARGS.internalKey] === "1") {
    cRouteRule = cRouteRule.filter(rule => rule[0] != "r.variables.remote_addr" 
      && rule[1] != "r.variables.remote_addr" && rule[2] != "r.variables.remote_addr");
  }
  // old proxy
  let proxyRules = cRouteRule.filter(rule => rule.length <= 4);
  proxyRules = proxyRules.filter(rule => !Object.keys(ROUTE_ENUM).includes(rule[0]));
  proxyRules = proxyRules.concat(cRouteRule
    .filter(rule => rule[0] === ROUTE_ENUM.proxy)
    // new proxy, remove routeMode
    .map(rule => rule.slice(1)));
  ngx.log(ngx.INFO, `getRouteMode proxyRules: ${JSON.stringify(proxyRules)}`);
  if (isProxy(r, proxyRules, filePath, isAlistRes, notLocal)) {
    return ROUTE_ENUM.proxy;
  }
  // new routeRules and not new proxy
  let routeRules = cRouteRule.filter(rule => {
    for (const rKey in ROUTE_ENUM) {
      if (ROUTE_ENUM[rKey] === rule[0] && rule[0] != ROUTE_ENUM.proxy) {
        return rule;
      }
    }
  });
  if (routeRules.length === 0 && isAlistRes) {
    // default value
    return ROUTE_ENUM.redirect;
  }
  const routeRulesObjArr = groupBy(routeRules, 0);
  for (const rKey in routeRulesObjArr) {
    routeRules = routeRulesObjArr[rKey];
    // remove routeMode
    const oldRulesArr3D = routeRules.map(rRule => rRule.slice(1));
    if (routeRules.length > 4) {
      let matchedGroupKey = getMatchedRuleGroupKey(r, routeRules[0][1], oldRulesArr3D, filePath);
      if (matchedGroupKey) {
        ngx.log(ngx.WARN, `hit ${rKey}, group: ${matchedGroupKey}`);
        return rKey;
      }
    } else {
      const matchedRule = getMatchedRule(r, oldRulesArr3D, filePath);
      if (matchedRule) {
        ngx.log(ngx.WARN, `hit ${rKey}: ${JSON.stringify(matchedRule)}`);
        return rKey;
      }
    }
  }
  return ROUTE_ENUM.redirect;
}

function isProxy(r, proxyRules, filePath, isAlistRes, notLocal) {
  const disableRedirectRule = proxyRules;
  const mountPath = config.embyMountPath;
  if (!isAlistRes) {
    // local file not xxxMountPath first
    if (mountPath.every(path => path && !filePath.startsWith(path) && !notLocal)) {
      ngx.log(ngx.WARN, `hit proxy, not mountPath first: ${JSON.stringify(mountPath)}`);
      return true;
    }
  }
  
  const oldRules = disableRedirectRule.filter(rule => rule.length <= 3);
  if (oldRules.length === 0) {
    return false;
  }
  let matchedRule = getMatchedRule(r, oldRules, filePath);
  if (matchedRule) {
    ngx.log(ngx.WARN, `hit proxy: ${JSON.stringify(matchedRule)}`);
    return true;
  }
  const groupRulesObjArr = groupBy(disableRedirectRule.filter(rule => rule.length > 3), 0);
  if (Object.keys(groupRulesObjArr) === 0) {
    return false;
  }
  let matchedGroupKey;
  for (const gKey in groupRulesObjArr) {
    matchedGroupKey = getMatchedRuleGroupKey(r, gKey, groupRulesObjArr[gKey], filePath);
    if (matchedGroupKey) {
      ngx.log(ngx.WARN, `hit proxy, group: ${matchedGroupKey}`);
      return true;
    }
  }
  return false;
}

/**
 * getMatchedRuleGroupKey
 * @param {Object} r nginx objects, HTTP Request
 * @param {String} groupKey "115-alist"
 * @param {Array} groupRulesArr3D [["115-alist", "r.args.X-Emby-Client", 0, ["Emby Web", "Emby for iOS", "Infuse"]]]
 * @param {String} filePath mediaFilePath or alistRes link
 * @returns "115-alist"
 */
function getMatchedRuleGroupKey(r, groupKey, groupRulesArr3D, filePath) {
  let rvt;
  ngx.log(ngx.INFO, `getMatchedRuleGroupKey groupRulesArr3D: ${JSON.stringify(groupRulesArr3D)}`);
  // remove groupKey
  const oldRulesArr3D = groupRulesArr3D.map(gRule => gRule.slice(1));
  ngx.log(ngx.INFO, `getMatchedRuleGroupKey oldRulesArr3D: ${JSON.stringify(oldRulesArr3D)}`);
  if (oldRulesArr3D.every(rule => !!getMatchedRule(r, [rule], filePath))) {
    rvt = groupKey;
  }
  return rvt;
}

/**
 * getMatchedRule
 * @param {Object} r nginx objects, HTTP Request
 * @param {Array} ruleArr3D [["filePath", 3, /private/ig]]
 * @param {String} filePath mediaFilePath or alistRes link
 * @returns ["filePath", 3, /private/ig]
 */
function getMatchedRule(r, ruleArr3D, filePath) {
  return ruleArr3D.find(rule => {
    let sourceStr = filePath;
    if (rule[0] !== "filePath" && rule[0] !== "alistRes") {
      sourceStr = parseExpression(r, rule[0]);
    }
    let flag = false;
    ngx.log(ngx.WARN, `sourceStrValue, ${rule[0]} = ${sourceStr}`);
    if (!sourceStr) {
      return flag;
    }
    const matcher = rule[2];
    if (Array.isArray(matcher) 
      && matcher.some(m => strMatches(rule[1], sourceStr, m))) {
      flag = true;
    } else {
      flag = strMatches(rule[1], sourceStr, matcher);
    }
    return flag;
  });
}

/**
 * parseExpression
 * @param {Object} rootObj like r
 * @param {String} expression like "r.args.MediaSourceId", notice skipped "r."
 * @param {String} propertySplit like "."
 * @param {String} groupSplit like ":"
 * @returns parsed string
 */
function parseExpression(rootObj, expression, propertySplit, groupSplit) {
  if (arguments.length < 4) {
    if (arguments.length < 3) {
      if (arguments.length < 2) {
        throw new Error("Missing required parameter: rootObj");
      }
      propertySplit = ".";
      groupSplit = ":";
    } else {
      groupSplit = propertySplit;
      propertySplit = ".";
    }
  }

  if (typeof rootObj !== "object" || rootObj === null) {
    throw new Error("rootObj must be a non-null object");
  }
  
  if (typeof expression !== "string" || expression.trim() === "") {
    return undefined;
  }

  if (typeof propertySplit !== "string" || typeof groupSplit !== "string") {
    throw new Error("Property and group split must be strings");
  }

  const expGroups = expression.split(groupSplit);
  let values = [];

  expGroups.forEach(expGroup => {
    if (!expGroup.trim()) return;

    const expArr = expGroup.split(propertySplit);
    let val = rootObj;

    // skipped index 0
    for (var j = 1; j < expArr.length; j++) {
      var expPart = expArr[j];
      if (val != null && Object.hasOwnProperty.call(val, expPart)) {
        val = val[expPart];
      } else {
        val = "";
        ngx.log(ngx.ERR, `Property "${expPart}" not found in object`);
      }
    }

    values.push(val);
  });

  return values.join(groupSplit);
}

function strMapping(type, sourceValue, searchValue, replaceValue) {
  let str = sourceValue;
  if (type == 1) {
    str = searchValue + str;
    ngx.log(ngx.WARN, `strMapping append: ${searchValue}`);
  }
  if (type == 2) {
    str += searchValue;
    ngx.log(ngx.WARN, `strMapping unshift: ${searchValue}`);
  }
  if (type == 0) {
    str = str.replace(searchValue, replaceValue);
    ngx.log(ngx.WARN, `strMapping replace: ${searchValue} => ${replaceValue}`);
  }
  return str;
}

function strMatches(type, searchValue, matcher) {
  if (0 == type && searchValue.startsWith(matcher)) {
    return true;
  }
  if (1 == type && searchValue.endsWith(matcher)) {
    return true;
  }
  if (2 == type && searchValue.includes(matcher)) {
    return true;
  }
  if (3 == type && !!searchValue.match(matcher)) {
    return true;
  }
  return false;
}

// MediaSourceInfo{ Protocol }, String ($enum)(File, Http, Rtmp, Rtsp, Udp, Rtp, Ftp, Mms)
// live stream "IsInfiniteStream": true

function checkIsStrmByPath(filePath) {
  if (!!filePath) {
    // strm: filePath1-itemPath like: /xxx/xxx.strm
    return filePath.toLowerCase().endsWith(".strm");
  }
  return false;
}

function checkIsRemoteByPath(filePath) {
  if (!!filePath) {
    return !filePath.startsWith("/") && !filePath.startsWith("\\");
  }
  return false;
}

function getFileNameByPath(filePath) {
  return filePath ? filePath.replace(/.*[\\/]/, "") : "";
}

function redirectStrmLastLinkRuleFilter(filePath) {
  return config.redirectStrmLastLinkRule.filter(rule => {
    const matcher = rule[1];
    let flag;
    if (Array.isArray(matcher) 
      && matcher.some(m => strMatches(rule[0], filePath, m))) {
      flag = true;
    } else {
      flag = strMatches(rule[0], filePath, matcher);
    }
    return flag;
  });
}

function strmLinkFailback(url) {
  if (!url) {
    return url;
  }
  let rvt = alistLinkFailback(url);
  return rvt;
}

function alistLinkFailback(url) {
  let rvt = url;
  const alistAddr = config.alistAddr;
  const alistPublicAddr = config.alistPublicAddr;
  let uri = url.replace(alistAddr, "");
  if (!!alistAddr && url.startsWith(alistAddr) && !uri.startsWith("/d/")) {
    rvt = `${alistAddr}/d${uri}`;
    ngx.log(ngx.WARN, `hit alistLinkFailback, add /d: ${rvt}`);
    return rvt;
  }
  uri = url.replace(alistPublicAddr, "");
  if (!!alistPublicAddr && url.startsWith(alistPublicAddr) && !uri.startsWith("/d/")) {
    rvt = `${alistPublicAddr}/d${uri}`;
    ngx.log(ngx.WARN, `hit alistLinkFailback, add /d: ${rvt}`);
    return rvt;
  }
  return rvt;
}

function getItemIdByUri(uri) {
  const regex = /[A-Za-z0-9]+/g;
  return uri.replace("emby", "").replace("Sync", "").replace(/-/g, "").match(regex)[1];
}

function getItemInfo(r) {
  const embyHost = config.embyHost;
  const embyApiKey = config.embyApiKey;
  const itemId = getItemIdByUri(r.uri);
  const mediaSourceId = r.args.MediaSourceId
    ? r.args.MediaSourceId
    : r.args.mediaSourceId;
  const Etag = r.args.Tag;
  let api_key = r.args["X-Emby-Token"]
    ? r.args["X-Emby-Token"]
    : r.args.api_key;
  api_key = api_key ? api_key : embyApiKey;
  let itemInfoUri = "";
  if (r.uri.includes("JobItems")) {
	  itemInfoUri = `${embyHost}/Sync/JobItems?api_key=${api_key}`;
  } else {
    if (mediaSourceId) {
      itemInfoUri = `${embyHost}/Items?Ids=${mediaSourceId}&Fields=Path,MediaSources&Limit=1&api_key=${api_key}`;
    } else {
      itemInfoUri = `${embyHost}/Items?Ids=${itemId}&Fields=Path,MediaSources&Limit=1&api_key=${api_key}`;
    }
  }
  return { itemInfoUri, itemId , Etag, mediaSourceId, api_key };
}

async function dictAdd(dictName, key, value) {
  if (!key || !value) {
    return;
  }
  const dict = ngx.shared[dictName];
  const preValue = dict.get(key);
  if (!preValue || (!!preValue && preValue != value)) {
    dict.add(key, value);
    ngx.log(ngx.WARN, `${dictName} add: [${key}] : [${value}]`);
  }
}

async function cost(func) {
  if (!func || !(func instanceof Function)) {
    ngx.log(ngx.ERR, `target function not null or is not function`);
    return;
  }
  const args = Array.prototype.slice.call(arguments, 1);
  const start = Date.now();
  let rvt;
  try {
    rvt = func.apply(func, args);
    if (rvt instanceof Promise) {
      await rvt.then(
        realRvt => {
          const end = Date.now();
          ngx.log(ngx.WARN, `${end - start}ms, ${func.name} async function cost`);
          // return realRvt;
        },
        error => {
          const end = Date.now();
          ngx.log(ngx.ERR, `${end - start}ms, ${func.name} async function throw an error`);
          throw error;
        }
      );
    } else {
      const end = Date.now();
      ngx.log(ngx.WARN, `${end - start}ms, ${func.name} function cost`);
    }
  } catch (error) {
    const end = Date.now();
    ngx.log(ngx.ERR, `${end - start}ms, ${func.name} sync function throw an error`);
    throw error;
  }
  return rvt;
}

function getDeviceId(rArgs) {
  // jellyfin and old emby tv clients use DeviceId
  return rArgs["X-Emby-Device-Id"] ? rArgs["X-Emby-Device-Id"] : rArgs.DeviceId ?? rArgs.deviceId;
}

const crypto = require('crypto');
function calculateHMAC(data, key) {
  // 创建 HMAC 对象，并指定算法和密钥
  const hmac = crypto.createHmac('sha256', key);
  // 更新要计算的数据
  hmac.update(data);
  // 计算摘要并以 GoLang 中 URLEncoding 方式返回
  return hmac.digest('base64')
      .replaceAll("+", "-")
      .replaceAll("/", "_");
}

function addAlistSign(url, alistToken, alistSignExpireTime) {
  let path = url.match(/https?:\/\/[^\/]+(\/[^?#]*)/)[1]
  const startIndex = path.indexOf("/d/")
  if (url.indexOf("sign=") === -1 && startIndex !== -1) {
    // add sign param for alist
    if (url.indexOf("?") === -1) {
      url += "?"
    } else {
      url += "&"
    }
    const expiredHour = alistSignExpireTime ?? 0
    let time = 0;
    if (expiredHour !== 0) {
      time = Math.floor(Date.now() / 1000 + expiredHour * 3600)
    }
    path = path.substring(startIndex + 2).replaceAll('//','/')
    const signData = `${path}:${time}`
    ngx.log(ngx.WARN, `sign data: ${signData}`)
    const sign = calculateHMAC(signData, alistToken)
    url = `${url}sign=${sign}:${time}`
  }
  return url;
}

export default {
  ARGS,
  ROUTE_ENUM,
  CHCHE_LEVEL_ENUM,
  proxyUri,
  appendUrlArg,
  addDefaultApiKey,
  generateUrl,
  getCurrentRequestUrl,
  getCurrentRequestUrlPrefix,
  copyHeaders,
  getRouteMode,
  parseExpression,
  strMapping,
  strMatches,
  checkIsStrmByPath,
  checkIsRemoteByPath,
  getFileNameByPath,
  redirectStrmLastLinkRuleFilter,
  strmLinkFailback,
  getItemIdByUri,
  getItemInfo,
  dictAdd,
  cost,
  getDeviceId,
  calculateHMAC,
  addAlistSign,
};
