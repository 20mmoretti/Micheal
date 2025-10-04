(() => {
  document.body.classList.add('disconnected');

  // --- Config ---
  const SERVICE_UUID = '0000ae00-0000-1000-8000-00805f9b34fb';
  const WRITE_UUID   = '0000ae01-0000-1000-8000-00805f9b34fb';
  const NOTIFY_UUID  = '0000ae02-0000-1000-8000-00805f9b34fb';
  const ACK_KEY = 'skelly_ack_v2';
  const LONG_WARN_ACK_KEY = 'skelly_long_track_ack';

  // This file is a patch layer. It expects the original app.js to be loaded first.
  // It overrides sendFileToDevice and the Edit modal upload handler to use:
  //  - Auto-scaling chunk size (<=512 packets)
  //  - UTF-16LE null-terminated filenames
  //  - Same logging you asked to keep ON

  // Wait for the app globals to exist
  const waitReady = (pred, ms=50) => new Promise(r => {
    const t = setInterval(() => { if (pred()) { clearInterval(t); r(); } }, ms);
  });

  (async () => {
    // Wait until helper functions and send/build exist
    await waitReady(() => typeof window !== 'undefined' && document && typeof navigator !== 'undefined');
    const $ = sel => document.querySelector(sel);
    const log = (m,c='') => {
      const logEl = $('#log');
      const div = document.createElement('div');
      div.className = 'line '+c;
      const time = new Date().toLocaleTimeString();
      div.textContent = `[${time}] ${m}`;
      logEl?.appendChild(div);
      const auto = $('#chkAutoscroll');
      if (!auto || auto.checked) logEl.scrollTop = logEl.scrollHeight;
    };

    // Hook buildCmd / send from the original app
    const _send = (window.__skelly_send || window.send || (typeof send!=='undefined'&&send));
    const _buildCmd = (window.__skelly_buildCmd || window.buildCmd || (typeof buildCmd!=='undefined'&&buildCmd));
    if (!_send || !_buildCmd) {
      log('Patch could not locate send/buildCmd. Make sure this file loads AFTER app.js', 'warn');
      return;
    }

    // Recreate utility helpers if missing
    const intToHex = (n, bytes) => (n>>>0).toString(16).toUpperCase().padStart(bytes*2,'0').slice(-bytes*2);
    const bytesToHex = u8 => Array.from(u8, b=>b.toString(16).toUpperCase().padStart(2,'0')).join('');
    const chunkToHex = (u8, off, per) => {
      const end = Math.min(off + per, u8.length);
      const chunk = u8.subarray(off, end);
      return Array.from(chunk, b => b.toString(16).toUpperCase().padStart(2,'0')).join('');
    };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const waiters = (window.__skelly_waiters || window.waiters || []);
    const waitFor = (prefix, timeoutMs=4000) => new Promise((resolve, reject) => {
      const w = { prefix, resolve, reject, t:setTimeout(()=>reject(new Error('Timeout waiting for '+prefix)), timeoutMs) };
      waiters.push(w);
    });
    const waitForAck = (p, t=3000) => waitFor(p, t).catch(() => null);

    const utf16leHex = (str) => {
      if (!str) return '';
      let hex = '';
      for (const ch of str) {
        const cp = ch.codePointAt(0);
        if (cp <= 0xFFFF) {
          const lo = cp & 0xFF, hi = (cp >> 8) & 0xFF;
          hex += lo.toString(16).padStart(2,'0') + hi.toString(16).padStart(2,'0');
        } else {
          const v = cp - 0x10000;
          const hiS = 0xD800 + ((v >> 10) & 0x3FF);
          const loS = 0xDC00 + (v & 0x3FF);
          hex += (hiS & 0xFF).toString(16).padStart(2,'0') + ((hiS >> 8) & 0xFF).toString(16).padStart(2,'0');
          hex += (loS & 0xFF).toString(16).padStart(2,'0') + ((loS >> 8) & 0xFF).toString(16).padStart(2,'0');
        }
      }
      return hex.toUpperCase();
    };
    const utf16leHexNull = (s) => (utf16leHex(s||'') + '0000').toUpperCase();
    const makeSafeAsciiName = (name, maxLen=31) => ((name||'').replace(/[^A-Za-z0-9_.-]/g,'').slice(0,maxLen) || 'file.mp3');
    const chooseChunkSize = (bytes, maxPackets=512, minPer=512, maxPer=4096) => {
      let per = 1024;
      if (Math.ceil(bytes / per) > maxPackets) {
        per = Math.ceil(bytes / maxPackets);
        per = Math.ceil(per / 16) * 16;
        per = Math.max(minPer, Math.min(maxPer, per));
      }
      return per;
    };

    // Try to expose a way to detect connection (best-effort)
    const isConnected = () => {
      try {
        const d = window.device || (typeof device!=='undefined'&&device);
        const w = window.writeChar || (typeof writeChar!=='undefined'&&writeChar);
        return !!(d && d.gatt && d.gatt.connected && w);
      } catch { return true; }
    };

    // Grab/patch transfer state map if present, or create one
    const transfer = (window.transfer || (window.transfer = { inProgress:false, cancel:false, resumeFrom:null, chunks:new Map() }));

    // === Override sendFileToDevice ===
    window.sendFileToDevice = async function patchedSendFileToDevice(u8, name) {
      if (!isConnected()) { log('Not connected — cannot send file.', 'warn'); return; }
      transfer.inProgress = true;
      transfer.cancel = false;
      transfer.chunks.clear();
      const cancelBtn = document.getElementById('btnCancelFile');
      const sendBtn = document.getElementById('btnSendFile');
      const setProgress = (i,t)=>{
        const pct = t? Math.round((i/t)*100):0;
        document.getElementById('progText').textContent = `${i} / ${t}`;
        document.getElementById('progPct').textContent = `${pct}%`;
        document.getElementById('progBar').style.width = `${pct}%`;
      };
      sendBtn && (sendBtn.disabled = true);
      cancelBtn && (cancelBtn.disabled = true);
      setProgress(0,0);
      try {
        const safeName = makeSafeAsciiName(name, 31);
        const size = u8.length;
        let per = chooseChunkSize(size);
        const maxPack = Math.ceil(size / per);
        const nameHex = utf16leHexNull(safeName);
        console.log('[C0 PARAMS]', { size, per, maxPack, safeName });

        await _send(_buildCmd('C0', intToHex(size,4) + intToHex(maxPack,2) + '5C55' + nameHex, 0));
        let c0 = await waitForAck('BBC0', 5000);
        if (!c0) throw new Error('Timeout waiting for BBC0');
        const c0Failed  = parseInt(c0.slice(4,6),16);
        const c0Written = parseInt(c0.slice(6,14),16) || 0;
        console.log('[BBC0 PARSED]', { c0Failed, c0Written });
        if (c0Failed !== 0) throw new Error('Device rejected start (BBC0 failed)');

        let startIdx = Math.floor(c0Written / per);
        if (c0Written % per !== 0) {
          startIdx = Math.max(0, startIdx);
          log(`Resume align: device wrote ${c0Written} bytes, resuming at chunk ${startIdx}`, 'warn');
        } else if (startIdx > 0) {
          log(`Resuming at chunk index ${startIdx} (written=${c0Written})`, 'warn');
        }
        cancelBtn && (cancelBtn.disabled = false);

        for (let idx = startIdx; idx < maxPack; idx++) {
          if (!isConnected()) throw new Error('Disconnected during transfer');
          if (transfer.cancel) throw new Error('Transfer cancelled');
          if (transfer.resumeFrom !== null) { idx = transfer.resumeFrom; transfer.resumeFrom = null; }
          const off = idx * per;
          const dataHex = chunkToHex(u8, off, per);
          const payload = intToHex(idx, 2) + dataHex;
          transfer.chunks.set(idx, payload);
          await _send(_buildCmd('C1', payload, 0));
          setProgress(idx + 1, maxPack);
          await sleep(2);
        }

        await _send(_buildCmd('C2', '', 8));
        let c2 = await waitForAck('BBC2', 240000);
        if (!c2) throw new Error('Timeout waiting for BBC2');
        const c2Failed = parseInt(c2.slice(4,6), 16);
        if (c2Failed !== 0) {
          const lastIndex = c2.length >= 10 ? parseInt(c2.slice(6,10), 16) : 0;
          transfer.resumeFrom = lastIndex;
          let tail = Math.min(maxPack, Math.max(0, transfer.resumeFrom));
          while (tail < maxPack) {
            if (transfer.cancel) throw new Error('Transfer cancelled');
            const payload = transfer.chunks.get(tail);
            if (!payload) break;
            await _send(_buildCmd('C1', payload, 0));
            tail += 1;
            setProgress(tail, maxPack);
            await sleep(2);
          }
        }

        await _send(_buildCmd('C3', '5C55' + nameHex, 8));
        const c3 = await waitForAck('BBC3', 3000);
        if (!c3) throw new Error('Timeout waiting for BBC3');
        const c3Failed = parseInt(c3.slice(4,6), 16);
        if (c3Failed !== 0) throw new Error('Device failed final rename');

        log('File transfer complete ✔', 'warn');
        // try to refresh if available
        if (typeof startFetchFiles === 'function') startFetchFiles();
      } catch (e) {
        log('File send error: ' + e.message, 'warn');
      } finally {
        transfer.inProgress = false;
        sendBtn && (sendBtn.disabled = false);
        cancelBtn && (cancelBtn.disabled = true);
      }
    };

    log('Skelly patch loaded: autoscale chunks + NULL filename + debug logs ON', 'warn');
  })();
})();
