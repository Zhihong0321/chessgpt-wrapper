const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());

// The exact localStorage data extracted from the successful login
const localStorageData = {
    "user": "{\"token\":\"eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjI0MTkzLCJyb2xlIjowLCJsb2dpbklkIjoiZWQyNjY1NDUtMWYzYy00NzcxLTlmNTgtYzJkMmU0YmQ0NDkxIiwidW5hbWUiOiJjbGF1ZGUwMSIsImV4cCI6MTc3Nzg2OTQxN30.vW8EaI3dskDOWWjC1aUFTtHYXsjJ62BuGblE_qKv-hI\",\"id\":24193,\"username\":\"claude01\",\"isPlus\":2,\"isPro\":1,\"expireTime\":\"2026-05-05 11:22:18\",\"isLogin\":true,\"email\":\"claude01@eternalgy.com\",\"affCode\":\"4GLR74\",\"plusExpireTime\":\"2026-05-05 11:22:18\",\"claudeExpireTime\":\"2026-05-05 11:22:18\",\"claudeProExpireTime\":\"2026-05-05 11:22:18\",\"grokExpireTime\":\"2026-05-05 11:22:18\",\"grokSuperExpireTime\":null,\"loginType\":1}",
    "device_id": "64b60e9817831c10e473fc1ece248b40",
    "accessToken": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjI0MTkzLCJyb2xlIjowLCJsb2dpbklkIjoiZWQyNjY1NDUtMWYzYy00NzcxLTlmNTgtYzJkMmU0YmQ0NDkxIiwidW5hbWUiOiJjbGF1ZGUwMSIsImV4cCI6MTc3Nzg2OTQxN30.vW8EaI3dskDOWWjC1aUFTtHYXsjJ62BuGblE_qKv-hI",
    "refreshToken": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjI0MTkzLCJyb2xlIjp0cnVlLCJ1bmFtZSI6ImNsYXVkZTAxIiwicmVmcmVzaFRva2VuSWQiOiI5OTIzMDU2YS0zNTZjLTQyYWQtYjUwOC04N2UxNzZhNDlhOGIiLCJ0eXBlIjoicmVmcmVzaCIsImV4cCI6MTgxMzg2NDkxN30.vNMT-HgTyn_zVQvA67p2izEDp3nemJYtEi02S2bdnWo",
    "user_model_preference": "{\"preference\":{\"modelName\":\"Claude+GPT优选不降智\",\"modelType\":\"sass\",\"timestamp\":1777868516497},\"timestamp\":1777868516497}"
};

const cookiesData = "JSESSIONID=LNMFjAbABq4Q1JESWAYO3vq0tNkU8l_Pg7MjMurq; username=claude01; password=U2FsdGVkX1/CPPB+BqwIsIY9/aqwh1dwUnIbCycCgi4=; rememberMe=true; visitor=false";

// Qwen Session Data
let qwenSession = null;
try {
    const sessionPath = path.join(__dirname, 'qwen_session.json');
    if (fs.existsSync(sessionPath)) {
        qwenSession = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    }
} catch (e) {
    console.warn('Qwen session not found or invalid.');
}

// 1. Unified Mobile Portal Route
app.get('/', (req, res) => {
    try {
        let html = fs.readFileSync(path.join(__dirname, 'public', 'portal.html'), 'utf8');
        const injection = `
            <script>
                window.INJECTED_LS = ${JSON.stringify(localStorageData)};
                window.INJECTED_COOKIES = "${cookiesData}";
            </script>
        `;
        html = html.replace('</head>', injection + '</head>');
        res.send(html);
    } catch (e) {
        res.status(500).send("Error loading portal: " + e.message);
    }
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const proxyOptions = {
    target: 'https://chat.chesspnt.com',
    changeOrigin: true,
    ws: true,
    onProxyReq: (proxyReq, req, res) => {
        proxyReq.setHeader('Cookie', cookiesData);
        proxyReq.setHeader('Origin', 'https://chat.chesspnt.com');
        proxyReq.setHeader('Referer', 'https://chat.chesspnt.com/list/');
    },
    onProxyRes: (proxyRes, req, res) => {
        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['x-frame-options'];
    },
    cookieDomainRewrite: { '*': '' }
};

const qwenProxyOptions = {
    target: 'https://chat.qwen.ai',
    changeOrigin: true,
    ws: true,
    onProxyReq: (proxyReq, req, res) => {
        if (qwenSession && qwenSession.cookies) {
            const cookieStr = qwenSession.cookies.map(c => c.name + '=' + c.value).join('; ');
            proxyReq.setHeader('Cookie', cookieStr);
        }
        proxyReq.setHeader('Origin', 'https://chat.qwen.ai');
        proxyReq.setHeader('Referer', 'https://chat.qwen.ai/');
    },
    onProxyRes: (proxyRes, req, res) => {
        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['x-frame-options'];
    },
    cookieDomainRewrite: { '*': '' }
};

app.use('/qwen', createProxyMiddleware(qwenProxyOptions));
app.use('/', createProxyMiddleware(proxyOptions));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('Team Proxy Server is running on http://localhost:' + PORT);
});
