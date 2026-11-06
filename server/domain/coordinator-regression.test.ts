import { it, expect } from 'vitest';
import { computeRemainingRefundable } from './balance.ts';
it('blocks a partially refunded capture when external refund history is unknown', () => {
 expect(computeRemainingRefundable({captureId:'cap', merchantId:'m',currency:'GBP',amountPennies:18000,status:'PARTIALLY_REFUNDED'}, [])).toBeNull();
});
