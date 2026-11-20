'use strict';

if (typeof Chart !== 'undefined') {
  const labels = Chart.defaults.plugins.legend.labels;
  const generateLabels = labels.generateLabels;
  labels.usePointStyle = true;
  labels.pointStyle = 'circle';
  labels.boxWidth = 12;
  labels.boxHeight = 12 / Math.SQRT2;
  labels.generateLabels = (chart) => generateLabels(chart).map((label) => {
    const dataset = chart.data.datasets[label.datasetIndex];
    const color = dataset && typeof dataset.borderColor === 'string' ? dataset.borderColor : label.fillStyle;
    return { ...label, fillStyle: color, strokeStyle: color, pointStyle: 'circle', lineWidth: 0 };
  });
}
