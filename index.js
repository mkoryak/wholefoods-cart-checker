const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const Promise = require('bluebird');
const fs = require('fs');
const moment = require('moment');
const path = require('path');
const express = require('express')
const app = express()
var os = require('os');
var ifaces = os.networkInterfaces();



require('dotenv').config({ path: path.resolve(process.cwd(), 'config.txt')})

// If these are null, you have to login manually. watch console.log
const AMAZON_PASSWORD = process.env.AMAZON_PASSWORD;
const AMAZON_EMAIL = process.env.AMAZON_EMAIL;
const TWILIO_CLIENT_ID = process.env.TWILIO_CLIENT_ID; 
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;
const YOUR_CELLPHONE = process.env.YOUR_CELLPHONE;
const REFRESH_INTERVAL_MINS = 1.5;
const DELAY_AFTER_FINDING_MINS = 60; // Dont spam with sms after finding a window.

// If false, will try to checkout amazon fresh cart. 
const checkoutWholefoods = true;

// Good idea to keep on. Sometimes when you first login you get a capcha. This script will wait while you to
// solve it and login manually. 
const DEBUG_WITH_NON_HEADLESS = true;


puppeteer.use(StealthPlugin());

const client = require('twilio')(TWILIO_CLIENT_ID, TWILIO_AUTH_TOKEN);
let consequitiveErrorCount = 0;
const BADNESS = Symbol();

let page;
let browser;

let canMakeOrder = false;

async function testSms() {
  const msg = {
    body: `Testing that this works.`,
    from: TWILIO_FROM,
    to: YOUR_CELLPHONE
  }; 
  try {
    await client.messages.create(msg);
  } catch(e) {
    console.log('error sending SMS.. ', e, msg);
  }
} 


async function sendSMS(offset, wtype, windows) {
  const msg = {
    body: `Amazon has "${wtype}" delivery window ${offset} days from now!\n${windows}\n\nhttps://www.amazon.com/gp/buy/shipoptionselect/handlers/display.html`,
    from: TWILIO_FROM,
    to: YOUR_CELLPHONE
  }; 
  try {
    await client.messages.create(msg);
  } catch(e) {
    console.log('error sending SMS.. ', e, msg);
  }
}

async function makeOrder() {
    console.log('trying to make order.. lets see if it works:)');
    await page.waitForSelector('.ufss-slot.ufss-available', {timeout: 3000});
    await page.click('.ufss-slot.ufss-available');
    await page.click('.a-button-input');
    await page.waitForSelector('#continue-top', {timeout: 3000});
    await page.click('#continue-top');
}

async function check() {

  canMakeOrder = false;
  let foundAvailability = false;
  let foundNothing = true;;
  const texts = await page.$$eval('.ufss-date-select-toggle-text-availability', 
    nodes => nodes.map(n => n.innerText));

  texts.forEach((text, i) => {
    foundNothing = false;
    console.log(`availability is:`, text,  i);
    if(text.trim() !== 'Not available'){
      foundAvailability = {i, msg:text};
    } 
  });
  

  if(foundAvailability) {
    let texts = '';
    try {
      texts = await page.$$eval('.ufss-slot.ufss-available .ufss-slot-time-window-text', 
            nodes => nodes.map(n => n.innerText));
      texts = texts.join('\n');
    } catch(e) {
      console.log('something bad when getting available times! ', e);
    }

    console.log('sending SMS at ', moment().toISOString());
    sendSMS(foundAvailability.i, foundAvailability.msg, texts);
    canMakeOrder = true;
    

    console.log('Found delivery windows, waiting 4 hours to check again');
    await Promise.delay(1000 * 60 * 60 * DELAY_AFTER_FINDING_MINS); // Wait before doing this again.
  } else {
    console.log(`Looking again in ${REFRESH_INTERVAL_MINS} minutes`);
    await Promise.delay(1000 * 60 * REFRESH_INTERVAL_MINS); // check again in X minutes.
  }

  const cookies = await page.cookies();
  fs.writeFileSync('./cookies.json', JSON.stringify(cookies, null, 2));

  if(!foundNothing) {
    await page.reload({
      waitUntil: "domcontentloaded"
    });
  }
}

async function evalButtonText(el) {
  return el.evaluate((el_) => {
    if(el_.classList.contains("a-button-input")) {
      return el_.parentNode.querySelector('.a-button-text').innerText.trim();
    } else {  
      return el_.innerText.trim();
    }
  });
}

async function dealWithShit() {
  await Promise.delay(1000 * 3);
  try {
    const title = await page.title();
    console.log('Process page:', title);
    if(title === 'Substitution preferences' || title === "Before you checkout") {
      try {
        await page.waitForSelector('.a-button-input');
        await page.click('.a-button-input');
      } catch (e) {
      }
    } else if(title === "Amazon.com Shopping Cart") {
      try { 
        await page.waitForSelector('.a-button-input', {timeout: 6000});
        const buttons = await page.$$('.a-button-input');
        let wholefoodsIndex = -1;
        let freshIndex = -1;
        console.log('You have these carts:');
        await Promise.all(buttons.map((button, i) => {
          return evalButtonText(button).then((text) => {
            if(text.match(/whole foods/i)) {
              wholefoodsIndex = i;
            }
            if(text.match(/fresh/i)) {
              freshIndex = i;
            }
            console.log(`#${i}: ${text}`);
          })
        }));
        const index = checkoutWholefoods ? wholefoodsIndex : freshIndex;
        if(index === -1) {
          console.log('Cannot checkout a cart you dont have! Prepare for error');
        }
        console.log(`>>> Monitoring ${checkoutWholefoods ? 'whole foods' : 'amazon fresh'} cart at index: ${index}`);
        await buttons[index].click()
         
        await page.waitForSelector('a[name="proceedToCheckout"]');
        await page.click('a[name="proceedToCheckout"]');
      } catch(e) {
        console.log('looks like we are not logged in...');
        const button = await page.$('.action-button');
        await page.click('.action-button');
      }
    } else if(title === "Your Amazon.com") {
      console.log('Saving your cookies to ./cookies.json');
      const cookies = await page.cookies();
      fs.writeFileSync('./cookies.json', JSON.stringify(cookies, null, 2));
      await page.goto('https://www.amazon.com/gp/cart/view.html?ref_=nav_cart', {
        waitUntil: "domcontentloaded"
      });
    } else if(title === "Amazon Password Assistance") {
      console.log('you are on Amazon Password Assistance page! Lets get out of here!');
      await page.goto('https://www.amazon.com/gp/cart/view.html?ref_=nav_cart', {
        waitUntil: "domcontentloaded"
      });
    } else if(title === "Reserve a Time Slot - Amazon.com Checkout") {
      // wait for a really long time in case the capcha comes up during login and i can solve it.
      await page.waitForSelector('.ufss-overview-container', {timeout: 1000 * 60 * 5});
      await check(page, browser);
    } else if(title === "Amazon Sign-In") {
      try {
        await page.waitForSelector('#continue', {timeout: 1000});
        if(AMAZON_EMAIL) {
          await page.type('#ap_email', AMAZON_EMAIL);
          await page.click('input#continue'); 
        } else {
          console.log("!!! Login to the site and wait for script, you have 1 minute.");
          await page.focus('#ap_email');
          await Promise.delay(1000 * 60 * 1); 
        }

      } catch(e) {
        try {
          await page.waitForSelector('#image-captcha-section', {timeout: 1000});
          console.log('SOLVE THIS CAPCHA! in 1 minute and click signin');
          await Promise.delay(1000 * 60 * 1); 
        } catch(e) {
          await page.waitForSelector('#ap_password');
          await page.click('input[name="rememberMe"]');
          if(AMAZON_PASSWORD) {
            await page.type('#ap_password', AMAZON_PASSWORD);
            await page.click('#signInSubmit');
          } else {
            console.log("!!! Login to the site and wait for script, you have 1 minute.");
            await page.focus('#ap_password');
            await Promise.delay(1000 * 60 * 1); 
          }
        }
      } 

    } else if(title === "Preparing your order"){
      await Promise.delay(1000 * 3); // nothing happens on this page... 
    } else {
      console.log('I dont know what to do on this page, hanging out here for a long time');
      await Promise.delay(1000 * 60 * 60 * 12); 
  //    console.log('I dont know what to do on this page, going back to cart selection.');
  //    await page.goto('https://www.amazon.com/gp/cart/view.html?ref_=nav_cart', {
  //      waitUntil: "domcontentloaded"
  //    });
    }
    consequitiveErrorCount = 0;
  } catch (e) {
    consequitiveErrorCount ++;
    console.log('error while processing page:\n', e);
    if(consequitiveErrorCount > 40) {
      consequitiveErrorCount = 0;
      return BADNESS;
    }
  }
}
async function setup(){
  console.log(`\nStarting at ${moment().toISOString()}`);
  browser = await puppeteer.launch({ headless: !DEBUG_WITH_NON_HEADLESS });
 
  page = await browser.newPage();

  if(fs.existsSync('./cookies.json')) {
    const cookies = JSON.parse(fs.readFileSync('./cookies.json'));
    console.log('mmmm we found some cookies, eating them!');
    await page.setCookie(...cookies);
  }

  await page.setViewport({
    width: 1280,
    height: 1050
  });

  await page.goto('https://www.amazon.com/gp/cart/view.html?ref_=nav_cart', {
      waitUntil: "domcontentloaded"
  });

  let breakingTermsOfService = true;
  do {
    const thing = await dealWithShit(page, browser);
    if(thing == BADNESS){
      breakingTermsOfService = false;
      await browser.close();
      console.log('I saw a lot of errors, starting everything over!');
      await Promise.delay(1000 * 60 * 10); 
      setImmidiate(() => {
        setup();
      })
    }
  } while(breakingTermsOfService);
}

try {
  setup();
} catch(e) {
  console.log('BADNESS HAPPEN:', e);
}



app.get('/', async (req, res) => {
  const encodedImg = await page.screenshot({encoding: 'base64'});
  res.setHeader('content-type', 'text/html');
  res.send(`<html><head><title>Using the blockchain for wholefoods deliveries!</title></head>
    <body>
    <h1><a href="/order" style="display:${canMakeOrder ? 'block': 'none'}; font-size: 34px; margin-bottom: 10px;">schedule first available window for me!<a><h1>
    <img src="data:image/png;base64, ${encodedImg}"></body></html>`);
});
app.get('/order', async (req, res) => {
  try {
    await makeOrder();
    res.redirect('/');
  } catch(e) {
    res.setHeader('content-type', 'text/html');
    res.send(`<html><head><title>Someone set us up the bomb!</title></head>
    <body><a href="/">Go back to that other useless page</a><br/>
    <h1>You have found the error page for the error page!</h1><pre>${e.stack}</pre></body></html>`);
  }
});

Object.keys(ifaces).forEach(function (ifname) {
  ifaces[ifname].forEach(function (iface) {
    if ('IPv4' !== iface.family || iface.internal !== false) {
      return;
    }
    console.log(`Server started on http://${iface.address}:3000/`);
  });
});

app.listen(process.env.PORT || 3000)
