// Shared definition of the five phone-native flows. Single source of truth so
// the hub tiles, the route dispatcher, and the nav manifest stay aligned.
// Each entry: { slug, label, sub, icon, accent }. `slug` is the /mobile/:flow
// route segment; `icon` is a lucide component name resolved by the consumer.

export const MOBILE_FLOWS = [
  { slug: 'health', label: 'Health & Restart', sub: 'System status, one-tap restart' },
  { slug: 'capture', label: 'Capture', sub: 'Drop a thought into your Brain' },
  { slug: 'ask', label: 'Ask', sub: 'What should I do now?' },
  { slug: 'approve', label: 'Approve', sub: 'Review CoS results' },
  { slug: 'log', label: 'Quick Log', sub: 'Log a drink or nicotine in seconds' },
];

export const MOBILE_FLOW_SLUGS = MOBILE_FLOWS.map((f) => f.slug);
