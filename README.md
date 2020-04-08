# wholefoods-cart-checker

You need nodejs.

In this folder run

`npm install`

Then edit config.txt and add all things that are needed.
- You need to register at twilio and they will give you ~10 bucks free money which is enough for much SMS.

# Using it for the first time

You need to have a wholefoods cart with items ready before you run this thing.

Edit config.txt and add your twilio credentials and sms sending phone number. 
You can also put your amazon email/password there. The benefit of doing that is that you dont have to log into amazon when you first start the program. 

If you do not add your amazon credentials into config.txt then you should log in to your amazon account after the app navigates to the login screen and then wait for it to continue doing its thing.

Watch console.log when you first run it and it will tell you to login.

When it thinks that it has successfully placed an order, the program will sleep for a very long time.

# Testing your twilio settings

Start the program, navigate to http://localhost:3000 and click 'send test sms'.

# Checkout your cart faster
Set `AUTO_ORDER_IF_POSSIBLE` to true in config. It will do it for you.

Or

This starts a server on localhost:3000 that will have a button that attempts to schedule a delivery. A link to this server will be texted to you if a delivery window is found.  

![it works](https://github.com/mkoryak/wholefoods-cart-checker/raw/gh-pages/pics/screenshot.png)

# Which cart?

By default this monitors wholefoods delivery windows. Change to amazon fresh by editing top of index.js `const checkoutWholefoods = true;`.

# Run it

`node index.js`

