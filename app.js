var casper = require('casper').create({   
    verbose: true, 
    logLevel: 'debug',
    pageSettings: {
         loadImages:  false,         // The WebPage instance used by Casper will
         loadPlugins: false,         // use these settings
         userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_7_5) AppleWebKit/537.4 (KHTML, like Gecko) Chrome/22.0.1229.94 Safari/537.4'
    },
    viewportSize: {
    	width: 1024,
    	height: 800
    }
});

var timeouts = {
	defaultTime: 5000,
	login: 8000
}
// print out all the messages in the headless browser context
casper.on('remote.message', function(msg) {
    this.echo('remote message caught: ' + msg);
});

// print out all the messages in the headless browser context
casper.on("page.error", function(msg, trace) {
    this.echo("Page Error: " + msg, "ERROR");
});

var url = 'https://www.okcupid.com/login';

casper.start(url, function() {
   // search for 'casperjs' from google form
   console.log("page loaded");
   if(this.exists('form#loginbox_form')){
    this.echo('login form found');
   }
   console.log('filling form');
   this.fill('form#loginbox_form', { 
        username: 'justame@gmail.com', 
        password:  'nirvana123'
    }, true);
});

casper.wait(timeouts.login, function(){
	casper.thenEvaluate(function(){
	 	console.log("Page Title " + document.title);
	});
}).then(function(){
	console.log('click on browse users');
	this.click('#nav_matches > a');
}).then(function(){
	this.wait(timeouts.defaultTime, function(){
		casper.thenEvaluate(function(){
		 	console.log("Page Title " + document.title);
		});
	})
})



casper.run();