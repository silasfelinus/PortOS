import { useState } from 'react';
import { Activity, RotateCw, CheckCircle, AlertTriangle, XCircle } from 'lucide-react';
import * as api from '../../services/api';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { useAutoRefetch } from '../../hooks/useAutoRefetch';
import { formatBytes } from '../../utils/formatters';

const HEALTH_STYLE = {
  healthy: { color: 'text-port-success', Icon: CheckCircle, label: 'Healthy' },
  warning: { color: 'text-port-warning', Icon: AlertTriangle, label: 'Warning' },
  critical: { color: 'text-port-error', Icon: XCircle, label: 'Critical' },
  unknown: { color: 'text-gray-400', Icon: AlertTriangle, label: 'Unknown' },
};

function tone(pct, warn, critical) {
  if (pct >= critical) return 'text-port-error';
  if (pct >= warn) return 'text-port-warning';
  return 'text-port-success';
}

// Flow 1 — system health + one-tap restart of an app. Reuses the same
// /system/health/details + /apps endpoints the desktop pages use; nothing
// here is mobile-specific on the server side.
export default function MobileHealthFlow() {
  const { data: health, loading } = useAutoRefetch(() => api.getSystemHealth({ silent: true }), 15_000);
  const { data: apps, loading: appsLoading } = useAutoRefetch(() => api.getApps({ silent: true }), 30_000);
  const [restartingId, setRestartingId] = useState(null);

  const restart = async (app) => {
    setRestartingId(app.id);
    // silent: this flow owns the error toast in the catch below.
    const result = await api.restartApp(app.id, { silent: true }).catch((err) => {
      toast.error(`Restart failed: ${err.message}`);
      return null;
    });
    setRestartingId(null);
    if (!result) return;
    if (result.selfRestart) {
      api.handleSelfRestart();
      return;
    }
    toast.success(`Restarting ${app.name}`);
  };

  if (loading && !health) {
    return <div className="flex justify-center py-12"><BrailleSpinner text="Loading health" /></div>;
  }

  // useAutoRefetch preserves the last good snapshot on error, so a null `health`
  // after the initial load means the fetch has never succeeded — show an
  // explicit unavailable state rather than a misleading "Healthy".
  if (!health) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center text-gray-500">
        <AlertTriangle size={32} aria-hidden="true" />
        <p className="text-base">System health is unavailable right now.</p>
      </div>
    );
  }

  // Unrecognized overallHealth falls to a neutral "unknown" style, never "healthy".
  const style = HEALTH_STYLE[health.overallHealth] || HEALTH_STYLE.unknown;
  const StatusIcon = style.Icon;
  const mem = health?.system?.memory;
  const disk = health?.system?.disk;
  const cpu = health?.system?.cpu;
  const thresholds = health?.thresholds || {};

  // Only active, PM2-managed apps can be restarted; archived apps and
  // others (Xcode/native, overallStatus 'n/a') have no restartable runtime.
  const restartable = (apps || []).filter((a) => !a.archived && a.overallStatus && a.overallStatus !== 'n/a');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-xl border border-port-border bg-port-card p-4">
        <StatusIcon size={32} className={style.color} aria-hidden="true" />
        <div>
          <div className={`text-lg font-bold ${style.color}`}>{style.label}</div>
          <div className="text-xs text-gray-400">{health?.hostname} · up {health?.system?.uptimeFormatted}</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {mem && (
          <Metric label="Memory" pct={mem.usagePercent} cls={tone(mem.usagePercent, thresholds.memoryWarn, thresholds.memoryCritical)}
            detail={`${formatBytes(mem.used)} / ${formatBytes(mem.total)}`} />
        )}
        {cpu && (
          <Metric label="CPU" pct={cpu.usagePercent} cls={tone(cpu.usagePercent, 80, 100)} detail={`${cpu.cores} cores`} />
        )}
        {disk && (
          <Metric label="Disk" pct={disk.usagePercent} cls={tone(disk.usagePercent, thresholds.diskWarn, thresholds.diskCritical)}
            detail={`${formatBytes(disk.free)} free`} />
        )}
      </div>

      {health?.warnings?.length > 0 && (
        <ul className="space-y-1">
          {health.warnings.map((w, i) => (
            <li key={i} className="flex items-center gap-2 rounded-lg bg-port-warning/10 px-3 py-2 text-sm text-port-warning">
              <AlertTriangle size={14} className="shrink-0" aria-hidden="true" />
              <span>{w.message}</span>
            </li>
          ))}
        </ul>
      )}

      <div>
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-300">
          <Activity size={16} aria-hidden="true" /> Apps
        </div>
        {appsLoading && !apps ? (
          <div className="flex justify-center py-6"><BrailleSpinner text="Loading apps" /></div>
        ) : restartable.length === 0 ? (
          <p className="py-4 text-center text-sm text-gray-500">No restartable apps.</p>
        ) : (
          <ul className="space-y-2">
            {restartable.map((app) => {
              const online = app.overallStatus === 'online';
              return (
                <li key={app.id} className="flex items-center justify-between gap-3 rounded-xl border border-port-border bg-port-card p-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-white">{app.name}</div>
                    <div className={`text-xs ${online ? 'text-port-success' : 'text-gray-500'}`}>{app.overallStatus}</div>
                  </div>
                  <button
                    onClick={() => restart(app)}
                    disabled={restartingId === app.id}
                    className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-port-accent/15 px-4 text-sm font-medium text-port-accent disabled:opacity-50"
                    aria-label={`Restart ${app.name}`}
                  >
                    <RotateCw size={16} className={restartingId === app.id ? 'animate-spin' : ''} aria-hidden="true" />
                    Restart
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Metric({ label, pct, cls, detail }) {
  return (
    <div className="rounded-xl border border-port-border bg-port-card p-3 text-center">
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-xl font-bold ${cls}`}>{pct}%</div>
      <div className="truncate text-[10px] text-gray-500">{detail}</div>
    </div>
  );
}
