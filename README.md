# wholefoods-cart-checker

You need nodejs.

In this folder run

`npm install`

Then edit config.txt and add all things that are needed.
- You need to register at twilio and they will give you ~10 bucks free money which is enough for much SMS.

# Using it

You no longer need to put your amazon credentials into config.txt.
If you do not, the first time the thing runs it will wait for you to login
to amazon in chromium. 

I do not know if there will be another login prompt later when the program is running, but if there is, it will fail if you arent around.

Watch console.log when you first run it and it will tell you to login.

# Checkout your cart faster
Set `AUTO_ORDER_IF_POSSIBLE` to true in config. It will do it for you.

Or

This starts a server on localhost:3000 that will have a button that attempts to schedule a delivery. A link to this server will be texted to you if a delivery window is found.  

![it works](https://github.com/mkoryak/wholefoods-cart-checker/raw/gh-pages/pics/screenshot.png)

# Which cart?

By default this monitors wholefoods delivery windows. Change to amazon fresh by editing top of index.js `const checkoutWholefoods = true;`.

# Run it

`node index.js`

