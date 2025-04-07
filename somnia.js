import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import blessed from "blessed";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";

const RPC_URL = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const PING_TOKEN_ADDRESS = process.env.PING_TOKEN_ADDRESS || "0x33E7fAB0a8a5da1A923180989bD617c9c2D1C493";
const PONG_TOKEN_ADDRESS = process.env.PONG_TOKEN_ADDRESS || "0x9beaA0016c22B646Ac311Ab171270B0ECf23098F";
const NETWORK_NAME = process.env.NETWORK_NAME || "SOMNIA TESTNET";
const swapContractAddress = process.env.SWAP_CONTRACT_ADDRESS || "0x6aac14f090a35eea150705f72d90e4cdc4a49b2c";
const swapContractABI = [
  {
    "inputs": [
      {
        "components": [
          { "internalType": "address", "name": "tokenIn", "type": "address" },
          { "internalType": "address", "name": "tokenOut", "type": "address" },
          { "internalType": "uint24", "name": "fee", "type": "uint24" },
          { "internalType": "address", "name": "recipient", "type": "address" },
          { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
          { "internalType": "uint256", "name": "amountOutMinimum", "type": "uint256" },
          { "internalType": "uint160", "name": "sqrtPriceLimitX96", "type": "uint160" }
        ],
        "internalType": "struct ExactInputSingleParams",
        "name": "params",
        "type": "tuple"
      }
    ],
    "name": "exactInputSingle",
    "outputs": [
      { "internalType": "uint256", "name": "amountOut", "type": "uint256" }
    ],
    "stateMutability": "payable",
    "type": "function"
  }
];

const PING_ABI = [
  "function mint() public payable",
  "function balanceOf(address owner) view returns (uint256)",
  "function isMinter(address account) view returns (bool)"
];

const PONG_ABI = [
  "function mint() public payable",
  "function balanceOf(address owner) view returns (uint256)",
  "function isMinter(address account) view returns (bool)"
];

function readWallets() {
  try {
    const data = fs.readFileSync("wallet.txt", "utf8");
    return data.split("\n").map(key => key.trim()).filter(key => key !== "");
  } catch (err) {
    console.error("Không thể đọc file wallet.txt:", err.message);
    return [];
  }
}

function readProxies() {
  try {
    const data = fs.readFileSync("proxy.txt", "utf8");
    return data.split("\n").map(proxy => proxy.trim()).filter(proxy => proxy !== "");
  } catch (err) {
    console.error("Không thể đọc file proxy.txt:", err.message);
    return [];
  }
}

const wallets = readWallets();
const proxies = readProxies();
let currentWalletIndex = 0;

let walletInfo = {
  address: "",
  balanceNative: "0.00",
  balancePing: "0.00",
  balancePong: "0.00",
  network: NETWORK_NAME,
  proxy: ""
};
let transactionLogs = [];
let autoSwapRunning = false;
let autoSwapCancelled = false;
let claimFaucetRunning = false;
let claimFaucetCancelled = false;
let autoSendRunning = false;
let autoSendCancelled = false;
let globalWallet = null;

function getShortAddress(address) {
  return address.slice(0, 6) + "..." + address.slice(-4);
}
function getShortHash(hash) {
  return hash.slice(0, 6) + "..." + hash.slice(-4);
}
function getShortProxy(proxy) {
  return proxy ? proxy.split('@')[1] || proxy : "Không có proxy";
}
let renderTimeout;
function safeRender() {
  if (renderTimeout) clearTimeout(renderTimeout);
  renderTimeout = setTimeout(() => {
    screen.render();
  }, 50);
}
function updateLogs() {
  logsBox.setContent(transactionLogs.join("\n"));
  logsBox.setScrollPerc(100);
  safeRender();
}
function addLog(message) {
  const timestamp = new Date().toLocaleTimeString();
  transactionLogs.push(`${timestamp}  ${message}`);
  updateLogs();
}
function clearTransactionLogs() {
  transactionLogs = [];
  updateLogs();
  addLog("Nhật ký giao dịch đã được xóa.");
}
function randomInRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function delay(ms) {
  return Promise.race([
    new Promise(resolve => setTimeout(resolve, ms)),
    new Promise(resolve => {
      const interval = setInterval(() => {
        if (autoSwapCancelled || autoSendCancelled || claimFaucetCancelled) {
          clearInterval(interval);
          resolve();
        }
      }, 1);
    })
  ]);
}

function getTokenName(address) {
  if (address.toLowerCase() === PING_TOKEN_ADDRESS.toLowerCase()) {
    return "Ping";
  } else if (address.toLowerCase() === PONG_TOKEN_ADDRESS.toLowerCase()) {
    return "Pong";
  } else {
    return address;
  }
}

function createProvider(proxy = null) {
  const httpOptions = proxy ? { agent: new HttpsProxyAgent(proxy) } : {};
  return new ethers.JsonRpcProvider(RPC_URL, undefined, httpOptions);
}

async function claimFaucetPing(walletIndex = currentWalletIndex) {
  if (claimFaucetRunning) {
    addLog("Yêu cầu Faucet Ping đang chạy.");
    return;
  }
  claimFaucetRunning = true;
  updateFaucetSubMenuItems();
  try {
    const pk = wallets[walletIndex].startsWith("0x") ? wallets[walletIndex] : "0x" + wallets[walletIndex];
    const proxy = proxies[walletIndex] || null;
    const provider = createProvider(proxy);
    const wallet = new ethers.Wallet(pk, provider);
    const pingContract = new ethers.Contract(PING_TOKEN_ADDRESS, PING_ABI, wallet);
    const alreadyMinted = await pingContract.isMinter(wallet.address);
    if (alreadyMinted) {
      addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Faucet PING đã được yêu cầu trước đó.`);
      return;
    }
    addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Đang yêu cầu Faucet Ping...`);
    const tx = await pingContract.mint({ value: 0 });
    addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Giao dịch đã gửi. Tx Hash: ${getShortHash(tx.hash)}`);
    await tx.wait();
    addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Yêu cầu Faucet Ping thành công!`);
    await delay(5000);
    updateWalletData(walletIndex);
  } catch (error) {
    addLog(`Ví ${getShortAddress(wallets[walletIndex])} (Proxy: ${getShortProxy(proxies[walletIndex])}): Yêu cầu Faucet Ping thất bại: ${error.message}`);
  } finally {
    claimFaucetRunning = false;
    updateFaucetSubMenuItems();
  }
}

async function claimFaucetPong(walletIndex = currentWalletIndex) {
  if (claimFaucetRunning) {
    addLog("Yêu cầu Faucet Pong đang chạy.");
    return;
  }
  claimFaucetRunning = true;
  updateFaucetSubMenuItems();
  try {
    const pk = wallets[walletIndex].startsWith("0x") ? wallets[walletIndex] : "0x" + wallets[walletIndex];
    const proxy = proxies[walletIndex] || null;
    const provider = createProvider(proxy);
    const wallet = new ethers.Wallet(pk, provider);
    const pongContract = new ethers.Contract(PONG_TOKEN_ADDRESS, PONG_ABI, wallet);
    const alreadyMinted = await pongContract.isMinter(wallet.address);
    if (alreadyMinted) {
      addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Faucet PONG đã được yêu cầu trước đó.`);
      return;
    }
    addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Đang yêu cầu Faucet Pong...`);
    const tx = await pongContract.mint({ value: 0 });
    addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Giao dịch đã gửi. Tx Hash: ${getShortHash(tx.hash)}`);
    await tx.wait();
    addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Yêu cầu Faucet Pong thành công!`);
    await delay(5000);
    updateWalletData(walletIndex);
  } catch (error) {
    addLog(`Ví ${getShortAddress(wallets[walletIndex])} (Proxy: ${getShortProxy(proxies[walletIndex])}): Yêu cầu Faucet Pong thất bại: ${error.message}`);
  } finally {
    claimFaucetRunning = false;
    updateFaucetSubMenuItems();
  }
}

async function updateWalletData(walletIndex = currentWalletIndex) {
  try {
    if (!wallets.length) {
      throw new Error("Không có ví nào trong wallet.txt");
    }
    const pk = wallets[walletIndex].startsWith("0x") ? wallets[walletIndex] : "0x" + wallets[walletIndex];
    const proxy = proxies[walletIndex] || null;
    const provider = createProvider(proxy);
    const wallet = new ethers.Wallet(pk, provider);
    globalWallet = wallet;
    walletInfo.address = wallet.address;
    walletInfo.proxy = proxy;
    const balanceNative = await provider.getBalance(wallet.address);
    walletInfo.balanceNative = ethers.formatEther(balanceNative);
    if (PING_TOKEN_ADDRESS) {
      const pingContract = new ethers.Contract(PING_TOKEN_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider);
      const pingBalance = await pingContract.balanceOf(wallet.address);
      walletInfo.balancePing = ethers.formatEther(pingBalance);
    }
    if (PONG_TOKEN_ADDRESS) {
      const pongContract = new ethers.Contract(PONG_TOKEN_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider);
      const pongBalance = await pongContract.balanceOf(wallet.address);
      walletInfo.balancePong = ethers.formatEther(pongBalance);
    }
    updateWallet();
    addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Số dư & Ví đã được cập nhật !!`);
  } catch (error) {
    addLog(`Ví ${getShortAddress(wallets[walletIndex])} (Proxy: ${getShortProxy(proxies[walletIndex])}): Không thể lấy dữ liệu ví: ${error.message}`);
  }
}

function updateWallet() {
  const shortAddress = walletInfo.address ? getShortAddress(walletInfo.address) : "N/A";
  const shortProxy = getShortProxy(walletInfo.proxy);
  const content = `{bold}{bright-blue-fg}Địa chỉ    :{/bright-blue-fg}{/bold} {bold}{bright-magenta-fg}${shortAddress}{/bright-magenta-fg}{/bold}
├─ {bold}{bright-yellow-fg}STT     :{/bright-yellow-fg}{/bold}{bold}{bright-green-fg} ${walletInfo.balanceNative}{/bright-green-fg}{/bold}
├─ {bold}{bright-yellow-fg}Ping    :{/bright-yellow-fg}{/bold}{bold}{bright-green-fg} ${walletInfo.balancePing}{/bright-green-fg}{/bold}
├─ {bold}{bright-yellow-fg}Pong    :{/bright-yellow-fg}{/bold}{bold}{bright-green-fg} ${walletInfo.balancePong}{/bright-green-fg}{/bold}
├─ {bold}{bright-yellow-fg}Proxy   :{/bright-yellow-fg}{/bold}{bold}{bright-cyan-fg} ${shortProxy}{/bright-cyan-fg}{/bold}
└─ {bold}{bright-yellow-fg}Mạng    :{/bright-yellow-fg}{/bold}{bold}{bright-red-fg} ${walletInfo.network} (Ví ${currentWalletIndex + 1}/${wallets.length}){/bright-red-fg}{/bold}`;
  walletBox.setContent(content);
  safeRender();
}

async function approveTokenForSwap(wallet, tokenAddress, spender, amount) {
  const erc20ABI = [
    "function approve(address spender, uint256 amount) returns (bool)"
  ];
  const tokenContract = new ethers.Contract(tokenAddress, erc20ABI, wallet);
  const maxApproval = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  const tx = await tokenContract.approve(spender, maxApproval);
  const proxy = proxies[wallets.indexOf(wallet.privateKey)] || null;
  addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Giao dịch phê duyệt đã gửi: ${getShortHash(tx.hash)}`);
  await tx.wait();
  addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Phê duyệt thành công.`);
}

async function autoClaimFaucetForAllWallets() {
  addLog("Bắt đầu yêu cầu faucet tự động cho tất cả ví...");
  for (let walletIndex = 0; walletIndex < wallets.length; walletIndex++) {
    if (claimFaucetCancelled) {
      addLog("Yêu cầu faucet tự động đã bị hủy.");
      break;
    }
    await claimFaucetPing(walletIndex);
    await delay(2000);
    await claimFaucetPong(walletIndex);
    await delay(2000);
  }
  addLog("Yêu cầu faucet tự động hoàn tất.");
}

async function autoSwapPingPong(totalSwaps) {
  try {
    if (!wallets.length) throw new Error("Không có ví nào trong wallet.txt");
    addLog(`Bắt đầu Auto Swap cho ${wallets.length} ví, mỗi ví ${totalSwaps} lần.`);
    for (let walletIndex = 0; walletIndex < wallets.length; walletIndex++) {
      const pk = wallets[walletIndex].startsWith("0x") ? wallets[walletIndex] : "0x" + wallets[walletIndex];
      const proxy = proxies[walletIndex] || null;
      const provider = createProvider(proxy);
      const wallet = new ethers.Wallet(pk, provider);
      const balanceNative = await provider.getBalance(wallet.address);
      const balanceInEther = ethers.formatEther(balanceNative);

      if (parseFloat(balanceInEther) < 0.01) {
        addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Số dư không đủ (${balanceInEther} STT). Bỏ qua swap.`);
        continue;
      }

      const swapContract = new ethers.Contract(swapContractAddress, swapContractABI, wallet);
      addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Bắt đầu Auto Swap ${totalSwaps} lần.`);
      for (let i = 0; i < totalSwaps; i++) {
        if (autoSwapCancelled) {
          addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Auto Swap đã bị hủy.`);
          break;
        }
        const swapDirection = Math.random() < 0.5 ? "PongToPing" : "PingToPong";
        let tokenIn, tokenOut;
        if (swapDirection === "PongToPing") {
          tokenIn = PONG_TOKEN_ADDRESS;
          tokenOut = PING_TOKEN_ADDRESS;
        } else {
          tokenIn = PING_TOKEN_ADDRESS;
          tokenOut = PONG_TOKEN_ADDRESS;
        }
        const randomAmount = randomInRange(50, 200);
        const amountIn = ethers.parseUnits(randomAmount.toString(), 18);
        const tokenInName = getTokenName(tokenIn);
        const tokenOutName = getTokenName(tokenOut);
        addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}) Swap ${i + 1}: Đang phê duyệt token ${tokenInName}...`);
        await approveTokenForSwap(wallet, tokenIn, swapContractAddress, amountIn);
        addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}) Swap ${i + 1}: Thực hiện swap từ ${tokenInName} -> ${tokenOutName} với số lượng ${randomAmount}`);
        const fee = 500;
        const recipient = wallet.address;
        const amountOutMin = 0;
        const sqrtPriceLimitX96 = 0n;
        try {
          const tx = await swapContract.exactInputSingle({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: recipient,
            amountIn: amountIn,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: sqrtPriceLimitX96
          });
          addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}) Swap ${i + 1} TX đã gửi: ${getShortHash(tx.hash)}`);
          await tx.wait();
          addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}) Swap ${i + 1} thành công.`);
          await updateWalletData(walletIndex);
        } catch (error) {
          addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}) Swap ${i + 1} thất bại: ${error.message}`);
        }
        if (i < totalSwaps - 1) {
          const delayMs = randomInRange(20000, 50000);
          addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Chờ ${delayMs / 1000} giây trước khi swap tiếp theo...`);
          await delay(delayMs);
        }
      }
      addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Auto Swap hoàn tất.`);
    }
    autoSwapRunning = false;
    updateSomniaSubMenuItems();
    updateFaucetSubMenuItems();
  } catch (err) {
    addLog("Lỗi trong Auto Swap: " + err.message);
    autoSwapRunning = false;
    updateSomniaSubMenuItems();
    updateFaucetSubMenuItems();
  }
}

function readRandomAddresses() {
  try {
    const data = fs.readFileSync("randomaddress.txt", "utf8");
    return data.split("\n").map(addr => addr.trim()).filter(addr => addr !== "");
  } catch (err) {
    addLog("Không thể đọc file randomaddress.txt: " + err.message);
    return [];
  }
}

async function autoSendTokenRandom(totalSends, tokenAmountStr) {
  try {
    if (!wallets.length) throw new Error("Không có ví nào trong wallet.txt");
    const addresses = readRandomAddresses();
    if (addresses.length === 0) {
      addLog("Danh sách địa chỉ trống.");
      return;
    }
    addLog(`Bắt đầu Auto Send Token cho ${wallets.length} ví, mỗi ví ${totalSends} lần.`);
    for (let walletIndex = 0; walletIndex < wallets.length; walletIndex++) {
      const pk = wallets[walletIndex].startsWith("0x") ? wallets[walletIndex] : "0x" + wallets[walletIndex];
      const proxy = proxies[walletIndex] || null;
      const provider = createProvider(proxy);
      const wallet = new ethers.Wallet(pk, provider);
      const balanceNative = await provider.getBalance(wallet.address);
      const balanceInEther = ethers.formatEther(balanceNative);

      if (parseFloat(balanceInEther) < 0.01) {
        addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Số dư không đủ (${balanceInEther} STT). Bỏ qua send token.`);
        continue;
      }

      addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Bắt đầu Auto Send Token ${totalSends} lần.`);
      for (let i = 0; i < totalSends; i++) {
        if (autoSendCancelled) {
          addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Auto Send Token đã bị hủy.`);
          break;
        }
        const randomIndex = randomInRange(0, addresses.length - 1);
        const targetAddress = addresses[randomIndex];
        addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}) Auto Send: Gửi ${tokenAmountStr} STT tới ${targetAddress}`);
        const tx = await wallet.sendTransaction({
          to: targetAddress,
          value: ethers.parseUnits(tokenAmountStr, 18)
        });
        addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}) Auto Send ${i + 1}/${totalSends} TX đã gửi: ${getShortHash(tx.hash)}`);
        await tx.wait();
        addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}) Auto Send ${i + 1}/${totalSends} thành công tới ${targetAddress}.`);
        await updateWalletData(walletIndex);
        if (i < totalSends - 1) {
          const delayMs = randomInRange(5000, 10000);
          addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Chờ ${delayMs / 1000} giây trước khi gửi tiếp theo...`);
          await delay(delayMs);
        }
      }
      addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Auto Send Token hoàn tất.`);
    }
    autoSendRunning = false;
    updateSendTokenSubMenuItems();
  } catch (err) {
    addLog("Lỗi trong Auto Send Token: " + err.message);
    autoSendRunning = false;
    updateSendTokenSubMenuItems();
  }
}

async function autoSendTokenChosen(targetAddress, tokenAmountStr) {
  try {
    if (!wallets.length) throw new Error("Không có ví nào trong wallet.txt");
    const walletIndex = currentWalletIndex;
    const pk = wallets[walletIndex].startsWith("0x") ? wallets[walletIndex] : "0x" + wallets[walletIndex];
    const proxy = proxies[walletIndex] || null;
    const provider = createProvider(proxy);
    const wallet = new ethers.Wallet(pk, provider);
    const balanceNative = await provider.getBalance(wallet.address);
    const balanceInEther = ethers.formatEther(balanceNative);

    if (parseFloat(balanceInEther) < 0.01) {
      addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Số dư không đủ (${balanceInEther} STT). Không thể gửi token.`);
      return;
    }

    addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Gửi ${tokenAmountStr} STT tới địa chỉ ${targetAddress}`);
    const tx = await wallet.sendTransaction({
      to: targetAddress,
      value: ethers.parseUnits(tokenAmountStr, 18)
    });
    addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Giao dịch đã gửi. Tx Hash: ${getShortHash(tx.hash)}`);
    await tx.wait();
    addLog(`Ví ${getShortAddress(wallet.address)} (Proxy: ${getShortProxy(proxy)}): Gửi token tới ${targetAddress} thành công.`);
    autoSendRunning = false;
    updateSendTokenSubMenuItems();
    await updateWalletData(walletIndex);
  } catch (err) {
    addLog(`Ví ${getShortAddress(wallets[currentWalletIndex])} (Proxy: ${getShortProxy(proxies[currentWalletIndex])}): Lỗi trong Send Token: ${err.message}`);
    autoSendRunning = false;
    updateSendTokenSubMenuItems();
  }
}

function updateSomniaSubMenuItems() {
  if (autoSwapRunning) {
    somniaSubMenu.setItems([
      "Auto Swap PING & PONG",
      "Dừng giao dịch",
      "Xóa nhật ký giao dịch",
      "Quay lại Menu chính",
      "Thoát"
    ]);
  } else {
    somniaSubMenu.setItems([
      "Auto Swap PING & PONG",
      "Xóa nhật ký giao dịch",
      "Quay lại Menu chính",
      "Thoát"
    ]);
  }
  safeRender();
}
function updateFaucetSubMenuItems() {
  if (autoSwapRunning || claimFaucetRunning) {
    faucetSubMenu.setItems([
      "Yêu cầu Faucet Ping (vô hiệu hóa)",
      "Yêu cầu Faucet Pong (vô hiệu hóa)",
      "Dừng giao dịch",
      "Xóa nhật ký giao dịch",
      "Quay lại Menu chính",
      "Thoát"
    ]);
  } else {
    faucetSubMenu.setItems([
      "Yêu cầu Faucet Ping",
      "Yêu cầu Faucet Pong",
      "Xóa nhật ký giao dịch",
      "Quay lại Menu chính",
      "Thoát"
    ]);
  }
  safeRender();
}
function updateSendTokenSubMenuItems() {
  if (autoSendRunning) {
    sendTokenSubMenu.setItems([
      "Auto Send Địa chỉ ngẫu nhiên (vô hiệu hóa)",
      "Gửi tới Địa chỉ được chọn (vô hiệu hóa)",
      "Dừng giao dịch",
      "Xóa nhật ký giao dịch",
      "Quay lại Menu",
      "Thoát"
    ]);
  } else {
    sendTokenSubMenu.setItems([
      "Auto Send Địa chỉ ngẫu nhiên",
      "Gửi tới Địa chỉ được chọn",
      "Xóa nhật ký giao dịch",
      "Quay lại Menu",
      "Thoát"
    ]);
  }
  safeRender();
}

const screen = blessed.screen({
  smartCSR: true,
  title: "Somnia Testnet Auto Swap, Yêu cầu Faucet & Auto Send Token",
  fullUnicode: true,
  mouse: true
});

const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  tags: true,
  style: { fg: "white" }
});

figlet.text("SOMNIA AUTO SWAP", { font: "Standard", horizontalLayout: "default" }, (err, data) => {
  if (err) {
    headerBox.setContent("{center}{bold}SOMNIA AUTO SWAP{/bold}{/center}");
  } else {
    headerBox.setContent(`{center}{bold}{green-fg}${data}{/green-fg}{/bold}{/center}`);
  }
  safeRender();
});

const descriptionBox = blessed.box({
  left: "center",
  width: "100%",
  content: "{center}{bold}{bright-magenta-fg}=== Follow Twitter: @PeterTran_CT ==={/bright-magenta-fg}{/bold}{/center}",
  tags: true,
  style: { fg: "white" }
});

const logsBox = blessed.box({
  label: " Nhật ký giao dịch ",
  left: "0%",
  border: { type: "line" },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  vi: true,
  tags: true,
  scrollbar: { ch: " ", inverse: true, style: { bg: "blue" } },
  style: {
    border: { fg: "red" },
    fg: "bright-cyan",
    bg: "default"
  }
});

const walletBox = blessed.box({
  label: " Thông tin Ví ",
  left: "60%",
  border: { type: "line" },
  tags: true,
  style: {
    border: { fg: "magenta" },
    fg: "white",
    bg: "default",
    align: "left",
    valign: "top"
  },
  content: ""
});

const mainMenu = blessed.list({
  label: " Menu ",
  left: "60%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: {
    selected: { bg: "green", fg: "black" },
    border: { fg: "yellow" },
    fg: "white"
  },
  items: [
    "Somnia Auto Swap",
    "Yêu cầu Faucet",
    "Auto Send Token",
    "Xóa nhật ký giao dịch",
    "Làm mới",
    "Chuyển ví tiếp theo",
    "Chọn Ví",
    "Thoát"
  ]
});

const somniaSubMenu = blessed.list({
  label: " Menu Somnia Auto Swap ",
  left: "60%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: {
    selected: { bg: "blue", fg: "white" },
    border: { fg: "yellow" },
    fg: "white"
  },
  items: []
});
somniaSubMenu.hide();

const faucetSubMenu = blessed.list({
  label: " Menu Yêu cầu Faucet ",
  left: "60%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: {
    selected: { bg: "blue", fg: "white" },
    border: { fg: "yellow" },
    fg: "white"
  },
  items: []
});
faucetSubMenu.hide();

const sendTokenSubMenu = blessed.list({
  label: " Menu Auto Send Token ",
  left: "60%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: {
    selected: { bg: "magenta", fg: "white" },
    border: { fg: "yellow" },
    fg: "white"
  },
  items: []
});
sendTokenSubMenu.hide();

const promptBox = blessed.prompt({
  parent: screen,
  border: "line",
  height: "20%",
  width: "50%",
  bottom: "2%",
  top: "center",
  left: "center",
  label: "{bright-blue-fg}Nhập{/bright-blue-fg}",
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  style: { fg: "bright-white", bg: "default", border: { fg: "red" } }
});

screen.append(headerBox);
screen.append(descriptionBox);
screen.append(logsBox);
screen.append(walletBox);
screen.append(mainMenu);
screen.append(somniaSubMenu);
screen.append(faucetSubMenu);
screen.append(sendTokenSubMenu);

screen.key(["escape", "q", "C-c"], () => process.exit(0));
screen.key(["C-up"], () => {
  logsBox.scroll(-1);
  safeRender();
});
screen.key(["C-down"], () => {
  logsBox.scroll(1);
  safeRender();
});

function adjustLayout() {
  const screenHeight = screen.height;
  const screenWidth = screen.width;
  const headerHeight = Math.max(8, Math.floor(screenHeight * 0.15));
  headerBox.height = headerHeight;
  headerBox.width = "100%";
  descriptionBox.top = "20%";
  descriptionBox.height = Math.floor(screenHeight * 0.05);
  logsBox.top = headerHeight + descriptionBox.height;
  logsBox.left = 0;
  logsBox.width = Math.floor(screenWidth * 0.6);
  logsBox.height = screenHeight - (headerHeight + descriptionBox.height);
  walletBox.top = headerHeight + descriptionBox.height;
  walletBox.left = Math.floor(screenWidth * 0.6);
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35);
  mainMenu.top = headerHeight + descriptionBox.height + walletBox.height;
  mainMenu.left = Math.floor(screenWidth * 0.6);
  mainMenu.width = Math.floor(screenWidth * 0.4);
  mainMenu.height = screenHeight - (headerHeight + descriptionBox.height + walletBox.height);
  somniaSubMenu.top = mainMenu.top;
  somniaSubMenu.left = mainMenu.left;
  somniaSubMenu.width = mainMenu.width;
  somniaSubMenu.height = mainMenu.height;
  faucetSubMenu.top = mainMenu.top;
  faucetSubMenu.left = mainMenu.left;
  faucetSubMenu.width = mainMenu.width;
  faucetSubMenu.height = mainMenu.height;
  sendTokenSubMenu.top = mainMenu.top;
  sendTokenSubMenu.left = mainMenu.left;
  sendTokenSubMenu.width = mainMenu.width;
  sendTokenSubMenu.height = mainMenu.height;

  safeRender();
}

screen.on("resize", adjustLayout);
adjustLayout();

safeRender();
mainMenu.focus();
updateLogs();
updateWalletData();

mainMenu.on("select", (item) => {
  const selected = item.getText();
  if (selected === "Somnia Auto Swap") {
    showSomniaSubMenu();
  } else if (selected === "Yêu cầu Faucet") {
    showFaucetSubMenu();
  } else if (selected === "Auto Send Token") {
    showSendTokenSubMenu();
  } else if (selected === "Xóa nhật ký giao dịch") {
    clearTransactionLogs();
  } else if (selected === "Làm mới") {
    updateWalletData();
    updateLogs();
    safeRender();
    addLog("Đã làm mới");
    mainMenu.focus();
  } else if (selected === "Chuyển ví tiếp theo") {
    currentWalletIndex = (currentWalletIndex + 1) % wallets.length;
    updateWalletData(currentWalletIndex);
    addLog(`Đã chuyển sang ví ${currentWalletIndex + 1}/${wallets.length} (Proxy: ${getShortProxy(proxies[currentWalletIndex])})`);
    mainMenu.focus();
  } else if (selected === "Chọn Ví") {
    if (!wallets.length) {
      addLog("Không có ví nào trong wallet.txt");
      return;
    }
    promptBox.setFront();
    promptBox.readInput(`Nhập số thứ tự ví (1-${wallets.length}):`, "", (err, value) => {
      promptBox.hide();
      safeRender();
      if (err || !value) {
        addLog("Dữ liệu nhập không hợp lệ hoặc bị hủy.");
        return;
      }
      const walletNum = parseInt(value);
      if (isNaN(walletNum) || walletNum < 1 || walletNum > wallets.length) {
        addLog(`Số thứ tự ví không hợp lệ. Vui lòng nhập từ 1 đến ${wallets.length}.`);
        return;
      }
      currentWalletIndex = walletNum - 1;
      updateWalletData(currentWalletIndex);
      addLog(`Đã chọn ví ${currentWalletIndex + 1}/${wallets.length} (Proxy: ${getShortProxy(proxies[currentWalletIndex])})`);
      mainMenu.focus();
    });
  } else if (selected === "Thoát") {
    process.exit(0);
  }
});

function showSomniaSubMenu() {
  mainMenu.hide();
  faucetSubMenu.hide();
  sendTokenSubMenu.hide();
  updateSomniaSubMenuItems();
  somniaSubMenu.show();
  somniaSubMenu.focus();
  safeRender();
}
somniaSubMenu.on("select", (item) => {
  const selected = item.getText();
  if (selected === "Auto Swap PING & PONG") {
    if (autoSwapRunning) {
      addLog("Giao dịch đang diễn ra, không thể bắt đầu giao dịch mới.");
      return;
    }
    promptBox.setFront();
    promptBox.readInput("Nhập số lần swap cho mỗi ví:", "", async (err, value) => {
      promptBox.hide();
      safeRender();
      if (err || !value) {
        addLog("Dữ liệu nhập không hợp lệ hoặc bị hủy.");
        return;
      }
      const totalSwaps = parseInt(value);
      if (isNaN(totalSwaps) || totalSwaps <= 0) {
        addLog("Số lần swap không hợp lệ.");
        return;
      }
      autoSwapRunning = true;
      autoSwapCancelled = false;
      claimFaucetCancelled = false;
      updateSomniaSubMenuItems();
      updateFaucetSubMenuItems();
      await autoClaimFaucetForAllWallets(); // Tự động yêu cầu faucet trước
      await autoSwapPingPong(totalSwaps);
      autoSwapRunning = false;
      updateSomniaSubMenuItems();
      updateFaucetSubMenuItems();
    });
  } else if (selected === "Dừng giao dịch") {
    if (!autoSwapRunning) {
      addLog("Không có giao dịch nào đang chạy.");
      return;
    }
    autoSwapCancelled = true;
    addLog("Lệnh dừng giao dịch đã được nhận (Somnia).");
  } else if (selected === "Xóa nhật ký giao dịch") {
    clearTransactionLogs();
  } else if (selected === "Quay lại Menu chính") {
    somniaSubMenu.hide();
    mainMenu.show();
    mainMenu.focus();
    safeRender();
  } else if (selected === "Thoát") {
    process.exit(0);
  }
});

function showFaucetSubMenu() {
  mainMenu.hide();
  somniaSubMenu.hide();
  sendTokenSubMenu.hide();
  updateFaucetSubMenuItems();
  faucetSubMenu.show();
  faucetSubMenu.focus();
  safeRender();
}
faucetSubMenu.on("select", (item) => {
  const selected = item.getText();
  if (selected === "Dừng giao dịch") {
    if (autoSwapRunning || claimFaucetRunning) {
      claimFaucetCancelled = true;
      addLog("Lệnh dừng giao dịch đã được nhận (Faucet).");
    } else {
      addLog("Không có giao dịch nào đang chạy.");
    }
    return;
  }
  if ((autoSwapRunning || claimFaucetRunning) && (selected.includes("Yêu cầu Faucet Ping") || selected.includes("Yêu cầu Faucet Pong"))) {
    addLog("Giao dịch đang diễn ra. Vui lòng dừng giao dịch trước khi yêu cầu faucet.");
    return;
  }
  if (selected.includes("Yêu cầu Faucet Ping")) {
    claimFaucetPing();
  } else if (selected.includes("Yêu cầu Faucet Pong")) {
    claimFaucetPong();
  } else if (selected === "Xóa nhật ký giao dịch") {
    clearTransactionLogs();
  } else if (selected === "Quay lại Menu chính") {
    faucetSubMenu.hide();
    mainMenu.show();
    mainMenu.focus();
    safeRender();
  } else if (selected === "Thoát") {
    process.exit(0);
  }
});

function showSendTokenSubMenu() {
  mainMenu.hide();
  somniaSubMenu.hide();
  faucetSubMenu.hide();
  updateSendTokenSubMenuItems();
  sendTokenSubMenu.show();
  sendTokenSubMenu.focus();
  safeRender();
}

sendTokenSubMenu.on("select", (item) => {
  const selected = item.getText();
  if (selected === "Auto Send Địa chỉ ngẫu nhiên") {
    if (autoSendRunning) {
      addLog("Giao dịch Auto Send đang chạy, không thể bắt đầu giao dịch mới.");
      return;
    }
    promptBox.setFront();
    promptBox.readInput("Nhập số lần gửi cho mỗi ví:", "", async (err, value) => {
      promptBox.hide();
      safeRender();
      if (err || !value) {
        addLog("Dữ liệu nhập số lần gửi không hợp lệ hoặc bị hủy.");
        return;
      }
      const totalSends = parseInt(value);
      if (isNaN(totalSends) || totalSends <= 0) {
        addLog("Số lần gửi không hợp lệ.");
        return;
      }
      promptBox.setFront();
      promptBox.readInput("Nhập số lượng token (STT) sẽ gửi (tối thiểu 0.0001, tối đa 0.01):", "", async (err2, tokenAmt) => {
        promptBox.hide();
        safeRender();
        if (err2 || !tokenAmt) {
          addLog("Dữ liệu nhập số lượng token không hợp lệ hoặc bị hủy.");
          return;
        }
        let amt = parseFloat(tokenAmt);
        if (isNaN(amt)) {
          addLog("Số lượng token phải là số.");
          return;
        }
        if (amt < 0.0001 || amt > 0.01) {
          addLog("Số lượng token phải từ 0.0001 đến 0.01 STT.");
          return;
        }
        autoSendRunning = true;
        autoSendCancelled = false;
        updateSendTokenSubMenuItems();
        await autoSendTokenRandom(totalSends, tokenAmt);
        autoSendRunning = false;
        updateSendTokenSubMenuItems();
      });
    });
  } else if (selected === "Gửi tới Địa chỉ được chọn") {
    if (autoSendRunning) {
      addLog("Giao dịch Auto Send đang chạy, không thể bắt đầu giao dịch mới.");
      return;
    }
    promptBox.setFront();
    promptBox.readInput("Nhập địa chỉ đích:", "", async (err, target) => {
      promptBox.hide();
      safeRender();
      if (err || !target) {
        addLog("Dữ liệu nhập địa chỉ không hợp lệ hoặc bị hủy.");
        return;
      }
      promptBox.setFront();
      promptBox.readInput("Nhập số lượng token (STT) sẽ gửi:", "", async (err2, tokenAmt) => {
        promptBox.hide();
        safeRender();
        if (err2 || !tokenAmt) {
          addLog("Dữ liệu nhập số lượng token không hợp lệ hoặc bị hủy.");
          return;
        }
        let amt = parseFloat(tokenAmt);
        if (isNaN(amt)) {
          addLog("Số lượng token phải là số.");
          return;
        }
        autoSendRunning = true;
        autoSendCancelled = false;
        updateSendTokenSubMenuItems();
        await autoSendTokenChosen(target, tokenAmt);
        autoSendRunning = false;
        updateSendTokenSubMenuItems();
      });
    });
  } else if (selected === "Dừng giao dịch") {
    if (autoSendRunning) {
      autoSendCancelled = true;
      addLog("Lệnh dừng giao dịch đã được nhận (Auto Send).");
    } else {
      addLog("Không có giao dịch nào đang chạy.");
    }
    return;
  } else if (selected === "Xóa nhật ký giao dịch") {
    clearTransactionLogs();
  } else if (selected === "Quay lại Menu") {
    sendTokenSubMenu.hide();
    mainMenu.show();
    mainMenu.focus();
    safeRender();
  } else if (selected === "Thoát") {
    process.exit(0);
  }
});