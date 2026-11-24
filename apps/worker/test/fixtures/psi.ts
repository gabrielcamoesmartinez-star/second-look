export const psiFixture = {
  lighthouseResult: {
    categories: {
      performance: { score: 0.49, auditRefs: [{ id: 'largest-contentful-paint', weight: 25 }, { id: 'total-blocking-time', weight: 30 }, { id: 'uses-optimized-images', weight: 0 }] },
      accessibility: { score: 0.86, auditRefs: [{ id: 'button-name', weight: 10 }, { id: 'color-contrast', weight: 7 }] },
    },
    audits: {
      'largest-contentful-paint': { title: 'Largest Contentful Paint', score: 0.2, displayValue: '4.8 s' },
      'total-blocking-time': { title: 'Total Blocking Time', score: 0.95, displayValue: '120 ms' },
      'cumulative-layout-shift': { title: 'Cumulative Layout Shift', score: 1, displayValue: '0.01' },
      'uses-optimized-images': { title: 'Efficiently encode images', score: 0 },
      'button-name': { title: 'Buttons do not have an accessible name', score: 0 },
      'color-contrast': { title: 'Contrast', score: 1 },
    },
  },
};

