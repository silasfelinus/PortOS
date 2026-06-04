import { useParams, Navigate, Link } from 'react-router-dom';
import { Activity, MessageSquarePlus, Sparkles, CheckSquare, ClipboardList, ChevronLeft, Smartphone } from 'lucide-react';
import { MOBILE_FLOWS } from '../components/mobile/flows';
import MobileHealthFlow from '../components/mobile/MobileHealthFlow';
import MobileCaptureFlow from '../components/mobile/MobileCaptureFlow';
import MobileAskFlow from '../components/mobile/MobileAskFlow';
import MobileApproveFlow from '../components/mobile/MobileApproveFlow';
import MobileLogFlow from '../components/mobile/MobileLogFlow';

// Icon + view component per flow slug. Kept here (not in flows.js) so the
// shared flow definition stays free of React/JSX imports for the nav manifest
// and tests that consume it.
const FLOW_UI = {
  health: { Icon: Activity, View: MobileHealthFlow },
  capture: { Icon: MessageSquarePlus, View: MobileCaptureFlow },
  ask: { Icon: Sparkles, View: MobileAskFlow },
  approve: { Icon: CheckSquare, View: MobileApproveFlow },
  log: { Icon: ClipboardList, View: MobileLogFlow },
};

// Phone-native quick-actions hub. `/mobile` shows the five tiles; each flow
// is its own deep-linkable route `/mobile/:flow` (≤2 taps to any action, and
// every flow is bookmarkable / shareable). All five flows reuse existing
// PortOS APIs — this page is a thumb-friendly surface, not new backend logic.
export default function Mobile() {
  const { flow } = useParams();

  if (flow) {
    const entry = MOBILE_FLOWS.find((f) => f.slug === flow);
    const ui = FLOW_UI[flow];
    if (!entry || !ui) {
      return <Navigate to="/mobile" replace />;
    }
    const { View, Icon } = ui;
    return (
      <div className="mx-auto h-full max-w-lg overflow-y-auto p-4">
        <div className="mb-4 flex items-center gap-2">
          <Link
            to="/mobile"
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center -ml-2 rounded-lg text-gray-400 hover:text-white"
            aria-label="Back to mobile hub"
          >
            <ChevronLeft size={22} aria-hidden="true" />
          </Link>
          <Icon size={20} className="text-port-accent" aria-hidden="true" />
          <h1 className="text-lg font-bold text-white">{entry.label}</h1>
        </div>
        <View />
      </div>
    );
  }

  return (
    <div className="mx-auto h-full max-w-lg overflow-y-auto p-4">
      <div className="mb-4 flex items-center gap-2">
        <Smartphone size={22} className="text-port-accent" aria-hidden="true" />
        <h1 className="text-xl font-bold text-white">Quick Actions</h1>
      </div>
      <div className="grid grid-cols-1 gap-3">
        {MOBILE_FLOWS.map((f) => {
          const Icon = FLOW_UI[f.slug]?.Icon || Smartphone;
          return (
            <Link
              key={f.slug}
              to={`/mobile/${f.slug}`}
              className="flex items-center gap-4 rounded-2xl border border-port-border bg-port-card p-4 active:bg-port-border/40"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-port-accent/15 text-port-accent">
                <Icon size={24} aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block text-base font-semibold text-white">{f.label}</span>
                <span className="block truncate text-sm text-gray-500">{f.sub}</span>
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
