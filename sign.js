#!/usr/bin/env node
// sign.js - Chronos Seal 内核签名工具
// 用法: node sign.js <内核目录> <私钥文件路径>

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TARGET_EXTS = ['.js', '.html', '.tmpl'];

function logInfo(m){ console.log('[Sign] ' + m); }
function logError(m){ console.error('[Sign] [ERROR] ' + m); }

const targetDir = process.argv[2];
const keyPath = process.argv[3];

if(!targetDir || !keyPath){
  logError('用法: node sign.js <内核目录> <私钥文件路径>');
  process.exit(1);
}
if(!fs.existsSync(targetDir)){ logError('目录不存在: ' + targetDir); process.exit(1); }
if(!fs.existsSync(keyPath)){ logError('私钥文件不存在: ' + keyPath); process.exit(1); }

const privKeyB64 = fs.readFileSync(keyPath, 'utf8').trim();
let privKeyBytes;
try { privKeyBytes = Buffer.from(privKeyB64, 'base64'); }
catch(e){ logError('私钥 Base64 解析失败'); process.exit(1); }

if(privKeyBytes.length !== 32){
  logError('私钥必须是 32 字节（当前 ' + privKeyBytes.length + ' 字节）');
  process.exit(1);
}

const PKCS8_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex');
const pkcs8Der = Buffer.concat([PKCS8_HEADER, privKeyBytes]);

let privateKeyObj;
try {
  privateKeyObj = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
} catch(e){ logError('私钥构造失败: ' + e.message); process.exit(1); }

const files = {};
function walk(dir, prefix){
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for(const entry of entries){
    const full = path.join(dir, entry.name);
    if(entry.isDirectory()){
      walk(full, prefix ? prefix + '/' + entry.name : entry.name);
    } else if(entry.isFile()){
      const ext = path.extname(entry.name).toLowerCase();
      if(TARGET_EXTS.indexOf(ext) < 0) continue;
      if(entry.name === 'manifest.json') continue;
      if(entry.name === 'manifest.sig') continue;
      const data = fs.readFileSync(full);
      const hash = crypto.createHash('sha256').update(data).digest('hex');
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      files[rel] = hash;
      logInfo('  ' + rel + ' = ' + hash.slice(0, 16) + '...');
    }
  }
}

logInfo('扫描目录: ' + targetDir);
walk(targetDir, '');

const fileCount = Object.keys(files).length;
if(fileCount === 0){ logError('目录里没有任何可签名的文件'); process.exit(1); }
logInfo('共 ' + fileCount + ' 个文件待签名');

const manifest = { generatedAt: new Date().toISOString(), files };
const manifestJson = JSON.stringify(manifest, null, 2);
const manifestBuffer = Buffer.from(manifestJson, 'utf8');
fs.writeFileSync(path.join(targetDir, 'manifest.json'), manifestJson, 'utf8');
logInfo('已写入 manifest.json');

let signature;
try { signature = crypto.sign(null, manifestBuffer, privateKeyObj); }
catch(e){ logError('签名失败: ' + e.message); process.exit(1); }

const sigB64 = signature.toString('base64');
fs.writeFileSync(path.join(targetDir, 'manifest.sig'), sigB64, 'utf8');
logInfo('已写入 manifest.sig');

const publicKeyObj = crypto.createPublicKey(privateKeyObj);
const verifyOk = crypto.verify(null, manifestBuffer, publicKeyObj, signature);
logInfo('自检验签: ' + (verifyOk ? '✅ 通过' : '❌ 失败'));

console.log('');
console.log('========================================');
console.log('  签名完成');
console.log('  目录: ' + targetDir);
console.log('  文件数: ' + fileCount);
console.log('========================================');
