import {it,expect} from 'vitest';
import {PayPalClient} from './paypal.ts';
it('rejects captures whose merchant identity cannot be established', async()=>{
 const transport=(async (url:any)=>new Response(JSON.stringify(String(url).endsWith('/oauth2/token')?{access_token:'t'}:{id:'CAP',status:'COMPLETED',amount:{value:'180.00',currency_code:'GBP'}}))) as typeof fetch;
 const client=new PayPalClient({configured:true,clientId:'id',clientSecret:'secret',merchantId:'M',baseUrl:'https://api-m.sandbox.paypal.com'},transport);
 await expect(client.getCapture('CAP')).rejects.toMatchObject({code:'PAYPAL_MERCHANT_UNKNOWN'});
});
