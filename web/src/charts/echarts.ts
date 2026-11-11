/**
 * ECharts 按需引入（只注册用到的图表 / 组件 / Canvas 渲染器），避免把整包打进产物。
 */
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, MarkLineComponent, MarkPointComponent, TooltipComponent } from 'echarts/components';
import { init, use } from 'echarts/core';
import type { EChartsType } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

use([LineChart, BarChart, GridComponent, TooltipComponent, MarkPointComponent, MarkLineComponent, CanvasRenderer]);

export { init };
export type { EChartsType };
