import { request } from './apiCore.js';

export const getDashboardLayouts = () => request('/dashboard/layouts');

export const setActiveDashboardLayout = (id) =>
  request('/dashboard/layouts/active', {
    method: 'PUT',
    body: JSON.stringify({ id }),
  });

// `activateWindow` is partial-aware: omit to preserve the existing value,
// pass `null` to clear, pass `{ start, end }` to set. Mirrors the merge in
// `server/services/dashboardLayouts.js#saveLayout`.
export const saveDashboardLayout = (id, { name, widgets, grid, activateWindow }) => {
  const body = { name, widgets, grid: grid ?? [] };
  if (activateWindow !== undefined) body.activateWindow = activateWindow;
  return request(`/dashboard/layouts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
};

export const deleteDashboardLayout = (id) =>
  request(`/dashboard/layouts/${encodeURIComponent(id)}`, { method: 'DELETE' });
