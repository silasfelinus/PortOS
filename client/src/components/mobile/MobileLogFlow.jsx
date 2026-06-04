import { useState } from 'react';
import { Wine, Cigarette, Check } from 'lucide-react';
import * as api from '../../services/api';
import toast from '../ui/Toast';
import { useAutoRefetch } from '../../hooks/useAutoRefetch';

// One-tap presets so the common case is a single tap (the ≤10-second goal).
// These mirror standard servings; custom items still surface from the user's
// saved presets below.
const DRINK_PRESETS = [
  { name: 'Beer', oz: 12, abv: 5 },
  { name: 'Wine', oz: 5, abv: 12 },
  { name: 'Shot', oz: 1.5, abv: 40 },
];
const NICOTINE_PRESETS = [
  { product: 'Cigarette', mgPerUnit: 12 },
  { product: 'Pouch', mgPerUnit: 6 },
  { product: 'Vape', mgPerUnit: 3 },
];

// Flow 5 — log a health/lifestyle event in ≤10 seconds. Tap a preset → it
// POSTs immediately to /meatspace/{alcohol,nicotine}/log. Reuses the user's
// saved custom drinks/products as extra one-tap buttons.
export default function MobileLogFlow() {
  const [tab, setTab] = useState('alcohol');
  const [busy, setBusy] = useState(null);
  const [lastLogged, setLastLogged] = useState(null);

  // Custom presets change rarely — poll slowly just to pick up edits made elsewhere.
  const { data: customDrinks } = useAutoRefetch(() => api.getCustomDrinks({ silent: true }), 300_000);
  const { data: customNicotine } = useAutoRefetch(() => api.getCustomNicotineProducts({ silent: true }), 300_000);

  const logDrink = async (drink) => {
    const key = `${drink.name}-${drink.oz}-${drink.abv}`;
    setBusy(key);
    const result = await api.logAlcoholDrink({ name: drink.name, oz: drink.oz, abv: drink.abv }).catch((err) => {
      toast.error(`Log failed: ${err.message}`);
      return null;
    });
    setBusy(null);
    if (!result) return;
    flash(`${drink.name} logged`);
  };

  const logNic = async (product) => {
    const key = `${product.product}-${product.mgPerUnit}`;
    setBusy(key);
    const result = await api.logNicotine({ product: product.product, mgPerUnit: product.mgPerUnit }).catch((err) => {
      toast.error(`Log failed: ${err.message}`);
      return null;
    });
    setBusy(null);
    if (!result) return;
    flash(`${product.product} logged`);
  };

  const flash = (msg) => {
    setLastLogged(msg);
    toast.success(msg);
    setTimeout(() => setLastLogged(null), 2500);
  };

  // Normalize both kinds into one button shape { key, label, detail, onTap }
  // so a single grid renders either tab.
  const buttons = tab === 'alcohol'
    ? [...DRINK_PRESETS, ...(Array.isArray(customDrinks) ? customDrinks : [])].map((d) => ({
      key: `${d.name}-${d.oz}-${d.abv}`,
      label: d.name,
      detail: `${d.oz}oz · ${d.abv}%`,
      onTap: () => logDrink(d),
    }))
    : [...NICOTINE_PRESETS, ...(Array.isArray(customNicotine)
      ? customNicotine.map((p) => ({ product: p.name, mgPerUnit: p.mgPerUnit }))
      : [])].map((p) => ({
      key: `${p.product}-${p.mgPerUnit}`,
      label: p.product,
      detail: `${p.mgPerUnit}mg`,
      onTap: () => logNic(p),
    }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 rounded-xl bg-port-card p-1">
        <TabBtn active={tab === 'alcohol'} onClick={() => setTab('alcohol')} Icon={Wine} label="Alcohol" />
        <TabBtn active={tab === 'nicotine'} onClick={() => setTab('nicotine')} Icon={Cigarette} label="Nicotine" />
      </div>

      {lastLogged && (
        <div className="flex items-center justify-center gap-2 rounded-lg bg-port-success/10 py-2 text-sm text-port-success">
          <Check size={16} aria-hidden="true" /> {lastLogged}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {buttons.map((b, i) => (
          <button
            key={`${b.key}-${i}`}
            onClick={b.onTap}
            disabled={busy === b.key}
            className="flex min-h-[72px] flex-col items-center justify-center rounded-xl border border-port-border bg-port-card disabled:opacity-50"
          >
            <span className="text-base font-semibold text-white">{b.label}</span>
            <span className="text-xs text-gray-500">{b.detail}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, Icon, label }) {
  return (
    <button
      onClick={onClick}
      className={`flex min-h-[44px] items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors ${
        active ? 'bg-port-accent text-white' : 'text-gray-400'
      }`}
    >
      <Icon size={16} aria-hidden="true" /> {label}
    </button>
  );
}
