import { registerKernel } from '@agstudio/sdk/worklet';
import { AnalyzerKernel } from './kernel';
import { ANALYZER_ID, analyzerParams } from './params';

registerKernel(ANALYZER_ID, analyzerParams, AnalyzerKernel);
