const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

let mainWindow = null;

const exeDir = path.dirname(app.getPath('exe'));
app.setPath('userData', path.join(exeDir, 'Config'));
app.setPath('sessionData', path.join(exeDir, 'Config'));

// ============================================================
// 常量
// ============================================================
const GITHUB_CLIENT_ID = 'Iv23liFUMvAWTK75MEx4';
const CALLBACK_PORT = 8080;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

// ============================================================
// 窗口
// ============================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 720,
    minHeight: 480,
    frame: false,
    backgroundColor: '#0e0e12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.on('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window-close', () => { if (mainWindow) mainWindow.close(); });

// ============================================================
// 工具函数
// ============================================================
function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function httpsPost(hostname, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname,
      path: pathname,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }, headers || {})
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
        catch (e) { reject(new Error('响应解析失败: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function httpsGet(hostname, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path: pathname,
      method: 'GET',
      headers: headers || {}
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
        catch (e) { reject(new Error('响应解析失败: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ============================================================
// 本地回调服务器
// ============================================================
function waitForCallback(timeoutMs) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, `http://127.0.0.1:${CALLBACK_PORT}`);
        if (url.pathname !== '/callback') {
          res.writeHead(404);
          res.end();
          return;
        }
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (code) {
          res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0e0e12;color:#e8e8ef;"><h2>授权成功</h2><p>请返回 Chronos Seal 继续操作。</p></body></html>');
        } else {
          res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0e0e12;color:#ef4444;"><h2>授权失败</h2><p>' + (error || '未知错误') + '</p></body></html>');
        }

        server.close();
        if (code) resolve(code);
        else reject(new Error(error || '用户拒绝授权'));
      } catch (e) {
        reject(e);
      }
    });

    server.on('error', (e) => {
      reject(new Error('无法启动本地回调服务器（端口 ' + CALLBACK_PORT + ' 可能被占用）: ' + e.message));
    });

    server.listen(CALLBACK_PORT, '127.0.0.1', () => { /* ready */ });

    setTimeout(() => {
      server.close();
      reject(new Error('授权超时（5 分钟）'));
    }, timeoutMs || 5 * 60 * 1000);
  });
}

// ============================================================
// OAuth 主流程
// ============================================================
ipcMain.handle('github-login', async (event, { proxyUrl }) => {
  const proxy = proxyUrl || 'https://proxy.crclare.top';
  const { verifier, challenge } = generatePKCE();
  const callbackPromise = waitForCallback(5 * 60 * 1000);

  const authUrl = 'https://github.com/login/oauth/authorize'
    + '?client_id=' + encodeURIComponent(GITHUB_CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI)
    + '&scope=' + encodeURIComponent('repo user workflow')
    + '&code_challenge=' + challenge
    + '&code_challenge_method=S256';

  await shell.openExternal(authUrl);

  const code = await callbackPromise;

  const proxyUrlObj = new URL(proxy);
  const proxyPath = proxyUrlObj.pathname + (proxyUrlObj.search || '');
  const tokenRes = await httpsPost(
    proxyUrlObj.hostname,
    proxyPath,
    { code, code_verifier: verifier }
  );

  if (tokenRes.json.error) {
    throw new Error('Proxy 换 token 失败：' + tokenRes.json.error);
  }
  const accessToken = tokenRes.json.access_token;
  if (!accessToken) {
    throw new Error('Proxy 未返回 access_token');
  }

  const userRes = await httpsGet('api.github.com', '/user', {
    'User-Agent': 'Chronos-Seal-GUI',
    'Authorization': 'Bearer ' + accessToken,
    'Accept': 'application/vnd.github+json'
  });

  if (userRes.status !== 200 || !userRes.json.login) {
    throw new Error('获取 GitHub 用户信息失败');
  }

  const tokenFile = path.join(exeDir, 'Config', 'GithubToken');
  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, accessToken, { encoding: 'utf8', mode: 0o600 });
  } catch (e) { /* non-fatal */ }

  return {
    login: userRes.json.login,
    avatar_url: userRes.json.avatar_url || ''
  };
});

ipcMain.handle('github-device-flow-start', async () => {
  const res = await httpsPost(
    'github.com',
    '/login/device/code',
    { client_id: GITHUB_CLIENT_ID, scope: 'repo user workflow' },
    { 'Accept': 'application/json' }
  );
  if (res.json.error) throw new Error(res.json.error_description || res.json.error);
  return {
    device_code: res.json.device_code,
    user_code: res.json.user_code,
    verification_uri: res.json.verification_uri,
    expires_in: res.json.expires_in,
    interval: res.json.interval || 5
  };
});

ipcMain.handle('github-device-flow-poll', async (event, { deviceCode, interval }) => {
  const res = await httpsPost(
    'github.com',
    '/login/oauth/access_token',
    {
      client_id: GITHUB_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    },
    { 'Accept': 'application/json' }
  );

  if (res.json.error) {
    if (res.json.error === 'authorization_pending') return null;
    if (res.json.error === 'slow_down') return null;
    throw new Error(res.json.error_description || res.json.error);
  }

  const accessToken = res.json.access_token;
  const userRes = await httpsGet('api.github.com', '/user', {
    'User-Agent': 'Chronos-Seal-GUI',
    'Authorization': 'Bearer ' + accessToken,
    'Accept': 'application/vnd.github+json'
  });

  const tokenFile = path.join(exeDir, 'Config', 'GithubToken');
  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, accessToken, { encoding: 'utf8', mode: 0o600 });
  } catch (e) { /* non-fatal */ }

  return {
    login: userRes.json.login,
    avatar_url: userRes.json.avatar_url || ''
  };
});

ipcMain.handle('open-external', async (event, url) => {
  await shell.openExternal(url);
});

// ============================================================
// 启动
// ============================================================
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
