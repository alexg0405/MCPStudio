/**
 * Partitioned Rice coding of prediction residuals (RFC 9639 §9.2.7). The residual is cut into 2^order equal
 * partitions, each with its own Rice parameter `k`; `planRice` finds the cheapest order and parameters,
 * `writeRice` writes them.
 */
import type { BitWriter } from './flac-bits';

/** The deepest partition order tried (256 partitions). */
const MAX_PARTITION_ORDER = 8;
/** Rice parameters above this need the 5-bit parameter form (coding method 1) instead of 4 bits. */
const MAX_4_BIT_PARAMETER = 14;
const MAX_PARAMETER = 30;
/** Coding method 0 has 4-bit parameters, method 1 has 5-bit ones. */
type RiceMethod = 0 | 1;
const PARAMETER_BITS: Record<RiceMethod, number> = { 0: 4, 1: 5 };
/** The residual coding header: 2 bits of method, 4 bits of partition order. */
const RESIDUAL_HEADER_BITS = 2 + 4;

/** How a residual will be coded, and what that costs. */
export interface RicePlan {
  /** Estimated size in bits, including the residual header. */
  bits: number;
  /** Partition order: the residual is cut into 2^order partitions. */
  order: number;
  /** The Rice parameter of every partition. */
  params: number[];
  method: RiceMethod;
}

/** Maps a signed residual to an unsigned number (0, −1, 1, −2, 2 … become 0, 1, 2, 3, 4 …). */
export const zigzag = (value: number): number => (value >= 0 ? 2 * value : -2 * value - 1);

/**
 * The cheapest partition order and Rice parameters for `residual[predictorOrder…blockSize)`. The first
 * `predictorOrder` samples are the predictor's warm-up and are not Rice coded.
 */
export function planRice(residual: Int32Array, predictorOrder: number, blockSize: number): RicePlan {
  const maxOrder = deepestPartitionOrder(predictorOrder, blockSize);
  let partitionSums = sumsOfFinestPartitions(residual, predictorOrder, blockSize, maxOrder);
  let best: RicePlan | null = null;
  // Walk from the finest partitioning to the coarsest, merging pairs of sums as we go.
  for (let order = maxOrder; order >= 0; order--) {
    const partitionCount = 1 << order;
    const plan = costOfPartitioning(partitionSums, order, predictorOrder, blockSize);
    if (!best || plan.bits < best.bits) best = plan;
    if (order > 0) {
      const merged = new Float64Array(partitionCount / 2);
      for (let p = 0; p < partitionCount / 2; p++) {
        merged[p] = (partitionSums[2 * p] as number) + (partitionSums[2 * p + 1] as number);
      }
      partitionSums = merged;
    }
  }
  return best as RicePlan;
}

/** Partitions must divide the block evenly and each hold more samples than the predictor order. */
function deepestPartitionOrder(predictorOrder: number, blockSize: number): number {
  let order = 0;
  while (
    order < MAX_PARTITION_ORDER &&
    blockSize % (1 << (order + 1)) === 0 &&
    blockSize >> (order + 1) > predictorOrder
  ) {
    order++;
  }
  return order;
}

/** Sums of zigzagged residuals per partition of the finest order (the warm-up samples count as zero). */
function sumsOfFinestPartitions(
  residual: Int32Array,
  predictorOrder: number,
  blockSize: number,
  order: number,
): Float64Array {
  const partitionCount = 1 << order;
  const partitionSize = blockSize >> order;
  const sums = new Float64Array(partitionCount);
  for (let p = 0; p < partitionCount; p++) {
    let sum = 0;
    for (let i = Math.max(p * partitionSize, predictorOrder); i < (p + 1) * partitionSize; i++) {
      sum += zigzag(residual[i] as number);
    }
    sums[p] = sum;
  }
  return sums;
}

/** The best parameter for each partition of one partition order, and the total estimated bits. */
function costOfPartitioning(
  partitionSums: Float64Array,
  order: number,
  predictorOrder: number,
  blockSize: number,
): RicePlan {
  const partitionCount = 1 << order;
  const partitionSize = blockSize >> order;
  const params: number[] = [];
  let bits = RESIDUAL_HEADER_BITS;
  let maxParam = 0;
  for (let p = 0; p < partitionCount; p++) {
    const sampleCount = p === 0 ? partitionSize - predictorOrder : partitionSize;
    const { k, cost } = bestParameter(partitionSums[p] as number, sampleCount);
    params.push(k);
    maxParam = Math.max(maxParam, k);
    bits += cost;
  }
  const method: RiceMethod = maxParam > MAX_4_BIT_PARAMETER ? 1 : 0;
  bits += partitionCount * PARAMETER_BITS[method];
  return { bits, order, params, method };
}

/** Best Rice parameter for `sampleCount` values whose zigzagged sum is `sum`, and the estimated bits. */
function bestParameter(sum: number, sampleCount: number): { k: number; cost: number } {
  if (sampleCount <= 0) return { k: 0, cost: 0 };
  const mean = sum / sampleCount;
  let k = mean > 1 ? Math.min(MAX_PARAMETER, Math.floor(Math.log2(mean))) : 0;
  // Each value costs (k + 1) bits plus its quotient, which averages sum / 2^k over the partition.
  const cost = (parameter: number) => sampleCount * (parameter + 1) + sum / 2 ** parameter;
  if (k < MAX_PARAMETER && cost(k + 1) < cost(k)) k++;
  if (k > 0 && cost(k - 1) < cost(k)) k--;
  return { k, cost: Math.ceil(cost(k)) };
}

/** Writes the residual (which excludes the `warmup` samples the predictor starts from) as planned. */
export function writeRice(writer: BitWriter, residual: Int32Array, plan: RicePlan, warmup: number): void {
  writer.write(plan.method, 2);
  writer.write(plan.order, 4);
  const partitionCount = 1 << plan.order;
  const partitionSize = (residual.length + warmup) >> plan.order;
  const parameterBits = PARAMETER_BITS[plan.method];
  let i = 0;
  for (let p = 0; p < partitionCount; p++) {
    const k = plan.params[p] as number;
    writer.write(k, parameterBits);
    const sampleCount = p === 0 ? partitionSize - warmup : partitionSize;
    for (let j = 0; j < sampleCount; j++, i++) writer.writeRice(zigzag(residual[i] as number), k);
  }
}
