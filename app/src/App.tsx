import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Connection, Keypair } from "@solana/web3.js";
import {
  fetchConfig,
  loadWallet,
  navigate,
  requestFaucet,
  store,
  usdcBalance,
  usePath,
  type AppConfig,
} from "./lib.ts";
import { Home } from "./screens/Home.tsx";
import { Create } from "./screens/Create.tsx";
import { Scan } from "./screens/Scan.tsx";
import { TableView } from "./screens/TableView.tsx";

interface Ctx {
  wallet: Keypair;
  config: AppConfig;
  connection: Connection;
  balance: bigint | null;
  refreshBalance: () => Promise<void>;
  name: string;
  setName: (n: string) => void;
  funding: boolean;
}

const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => useContext(AppCtx)!;

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <div className="topbar">
        <button className="brand" onClick={() => navigate("/")}>
          QuickBet
        </button>
        <div className="pill">Demo · devnet · no real funds</div>
      </div>
      {children}
    </div>
  );
}

export function App() {
  const wallet = useMemo(loadWallet, []);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [funding, setFunding] = useState(false);
  const [name, setNameState] = useState(store.get("qb.name") ?? "");
  const path = usePath();

  const boot = useCallback(() => {
    setBootError(null);
    fetchConfig()
      .then(setConfig)
      .catch((e) => setBootError(String(e.message ?? e)));
  }, []);
  useEffect(boot, [boot]);

  const connection = useMemo(
    () => (config ? new Connection(config.rpcUrl, "confirmed") : null),
    [config]
  );

  const refreshBalance = useCallback(async () => {
    if (!connection || !config) return;
    setBalance(await usdcBalance(connection, wallet.publicKey, config.mint));
  }, [connection, config, wallet]);

  // First open: fund the burner wallet (idempotent on the server).
  useEffect(() => {
    if (!config) return;
    setFunding(true);
    requestFaucet(wallet.publicKey)
      .catch(() => {})
      .finally(() => {
        setFunding(false);
        refreshBalance();
      });
  }, [config, wallet, refreshBalance]);

  useEffect(() => {
    const t = setInterval(refreshBalance, 15000);
    return () => clearInterval(t);
  }, [refreshBalance]);

  const setName = (n: string) => {
    setNameState(n);
    store.set("qb.name", n);
  };

  if (!config || !connection) {
    return (
      <Shell>
        <div className="screen">
          {bootError ? (
            <>
              <h1>Can't reach the QuickBet server</h1>
              <div className="notice err">{bootError}</div>
              <button className="btn" onClick={boot}>
                Try again
              </button>
            </>
          ) : (
            <div className="body">Loading…</div>
          )}
        </div>
      </Shell>
    );
  }

  const ctx: Ctx = { wallet, config, connection, balance, refreshBalance, name, setName, funding };
  const m = path.match(/^\/t\/([1-9A-HJ-NP-Za-km-z]{32,44})/);

  return (
    <AppCtx.Provider value={ctx}>
      <Shell>
        {m ? (
          <TableView key={m[1]} table={m[1]} />
        ) : path === "/new" ? (
          <Create />
        ) : path === "/scan" ? (
          <Scan />
        ) : (
          <Home />
        )}
      </Shell>
    </AppCtx.Provider>
  );
}
