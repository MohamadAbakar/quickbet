import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { PublicKey } from "@solana/web3.js";
import { lookupCode, navigate } from "../lib.ts";

/** Accepts an invite URL (…/t/<table>), a raw table address, or a short code. */
function parseScan(text: string): string | null {
  const m = text.match(/\/t\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
  if (m) return m[1];
  try {
    return new PublicKey(text.trim()).toBase58();
  } catch {
    return null;
  }
}

export function Scan() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [camOn, setCamOn] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        const v = videoRef.current!;
        v.srcObject = stream;
        v.setAttribute("playsinline", "true");
        await v.play();
        setCamOn(true);
        const tick = () => {
          if (stopped) return;
          if (v.readyState === v.HAVE_ENOUGH_DATA && ctx) {
            canvas.width = v.videoWidth;
            canvas.height = v.videoHeight;
            ctx.drawImage(v, 0, 0);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
            const table = hit && parseScan(hit.data);
            if (table) return navigate(`/t/${table}`);
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        setCamError(
          window.isSecureContext
            ? "Camera not available. Allow camera access, or type the table code."
            : "The camera needs HTTPS. Use your phone's camera app on the QR code, or type the table code."
        );
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const join = async () => {
    setErr(null);
    const direct = parseScan(code);
    if (direct) return navigate(`/t/${direct}`);
    setBusy(true);
    try {
      navigate(`/t/${await lookupCode(code)}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen" style={{ gap: 18 }}>
      <h1 className="xl">Scan to join</h1>
      <div className="scanner">
        <video ref={videoRef} muted style={{ display: camOn ? "block" : "none" }} />
        {!camOn && <div className="small" style={{ padding: 24, textAlign: "center" }}>{camError ?? "Starting camera…"}</div>}
        <div className="corner tl" />
        <div className="corner tr" />
        <div className="corner bl" />
        <div className="corner br" />
      </div>
      <div className="body">Point your camera at the host's QR code. You see the game and the buy-in before anything is locked.</div>
      <div className="stack">
        <label htmlFor="tableCode" className="label">
          Or type the table code
        </label>
        <input
          id="tableCode"
          className="input"
          placeholder="TABLE-4821"
          value={code}
          inputMode="text"
          autoCapitalize="characters"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && join()}
        />
      </div>
      {err && <div className="notice err">{err}</div>}
      <div className="spacer" />
      <div className="stack" style={{ gap: 6 }}>
        <button className="btn" disabled={!code.trim() || busy} onClick={join}>
          {busy ? "Looking up table…" : "Find table"}
        </button>
        <button className="btn text" onClick={() => navigate("/")}>
          Cancel
        </button>
      </div>
    </div>
  );
}
