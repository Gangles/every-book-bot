var fs = require('fs');
var path = require('path');
var request = require('request');
var conf = require('./config.js');

// import twitter library: https://github.com/ttezel/twit
var Twitter = require('node-twitter');
var twitterRestClient = new Twitter.RestClient(
	conf.consumer_key,
	conf.consumer_secret,
	conf.access_token,
	conf.access_token_secret
);

// postgres database to track books we've already tweeted
var pg = require('pg.js');
var client = new pg.Client(process.env.DATABASE_URL);

// image manipulation: https://github.com/aheckmann/gm
var gm = require('gm').subClass({ imageMagick: true });
var sizeOf = require('image-size');

// rest client: https://github.com/aacerox/node-rest-client
var Client = require('node-rest-client').Client;
var restClient = new Client();

// use SSL when talking to google API
var ssl = {
    connection:{
		// magic encryption gibberish
        secureOptions: require('constants').SSL_OP_NO_TLSv1_2,
        ciphers:'ECDHE-RSA-AES256-SHA:AES256-SHA:RC4-SHA:RC4:HIGH:!MD5:!aNULL:!EDH:!AESGCM',
        honorCipherOrder: true
    }
};
var googleClient = new Client(ssl);

// avoid using slurs: https://github.com/dariusk/wordfilter/
var blacklist = [];
try {
	var data = fs.readFileSync('blacklist.json', 'ascii');
	data = JSON.parse(data);
	blacklist = data.badwords;
	console.log("Blacklist initialized with " + blacklist.length + " words.")
} catch (err) {
	console.log(err);
	process.exit(1);
}

// wordnik API information
var getNounsURL = "http://api.wordnik.com/v4/words.json/randomWords?"
+ "minCorpusCount=3000&minDictionaryCount=15&hasDictionaryDef=true&" +
+ "excludePartOfSpeech=proper-noun-posessive,suffix,family-name,idiom,affix&"
+ "includePartOfSpeech=noun,proper-noun&limit=10&maxLength=12&api_key=" + conf.wordnik_key;

// google books API information
var getBooksURL = "https://www.googleapis.com/books/v1/volumes?q=";

// make sure the temp folder exists
try {
	var temp_dir = path.join(process.cwd(), 'tmp/');
	if (!fs.existsSync(temp_dir)) fs.mkdirSync(temp_dir);
} catch (err) {
	console.log(err);
	process.exit(1);
}

// global bot variables
var subject = "";
var subjects = [];
var bookList = {};
var bookToTweet = {};

var BOOK_COVER = path.join(process.cwd(), '/tmp/cover.jpg');
var TILE_COVER = path.join(process.cwd(), '/tmp/cover_tiled.jpg');

var recentISBNs = [];
var recentSubjects = [];
var MAX_MEMORY = 300;

var attempts = 0;
var randomIndex = false;
var MAX_RESULTS = 40;
var MAX_ATTEMPTS = 35;
var DO_TWEET = true;

var DB_CREATE = 'CREATE TABLE IF NOT EXISTS books (isbn char(13) NOT NULL)';
var DB_QUERY = 'SELECT * FROM books WHERE isbn=$1';
var DB_INSERT = 'INSERT INTO books(isbn) VALUES ($1)';

function waitToBegin() {
	// database is initialized, schedule tweet on the hour
	var d = new Date();
	var timeout = 60 - d.getSeconds();
	timeout += (60 - d.getMinutes() - 1) * 60;
	console.log("Wait " + timeout + " for first tweet.");
	setTimeout(beginTweeting, timeout * 1000);
}

function beginTweeting() {
	// post a tweet, repeat every 60 minutes
	startNewTweet();
	setInterval(startNewTweet, 1000 * 60 * 60);
}

function startNewTweet() {
	try {
		// reset global variables
		subject = "";
		bookList = {};
		bookToTweet = {};
		attempts = 0;
		randomIndex = false;
		
		// limit how long before books/subjects can be reused
		while (recentISBNs.length > MAX_MEMORY) recentISBNs.shift();
		while (recentSubjects.length > MAX_MEMORY) recentSubjects.shift();
	
		// delete any leftover cover images
		if(fs.existsSync(BOOK_COVER)) fs.unlinkSync(BOOK_COVER);
		if(fs.existsSync(TILE_COVER)) fs.unlinkSync(TILE_COVER);
	
		// get a new random subject
		getNewSubject();
	} catch (e) {
		console.log("Initial setup error:", e.toString());
	}
}

function getNewSubject() {
	try {
		// pop the most recently used subject
		if (subjects.length > 0) subjects.shift();
		
		if (subjects.length > 0) {
			// use a locally cached subject
			chooseSubject();
		} else {
			// ask wordnik for random words
			restClient.get(getNounsURL, subjectCallback, "json");
		}
	} catch (e) {
		console.log("Wordnik request error:", e.toString());
	}
}

function subjectCallback(data) {
	try {
		// add all the new words to the local cache
		var words = JSON.parse(data);
		for (var i = 0; i < words.length; i++) {
			subjects.push(words[i].word);
		}
		chooseSubject();
	} catch (e) {
		console.log("Wordnik callback error:", e.toString());
	}
}

function chooseSubject() {
	try {
		if (subjects.length < 1) throw "Subject list should not be empty.";
		subject = subjects[0];
		
		if (contains(recentSubjects, subject)) {
			// we've used this subject recently
			console.log(subject + " used recently, get new subject.")
			getNewSubject();
		} else if (isOffensive(subject)) {
			// bad word filter found a match
			console.log(subject + " is offensive, get new subject.")
			getNewSubject();
		} else {
			// get books for this subject
			console.log("Look up books for: " + subject);
			getBooks(subject, 0);
		}
	} catch (e) {
		console.log("Subject error:", e.toString());
	}
}

function getBooks(subject, index) {
	try {
		// ask google for some books on the given subject
		++ attempts;
		var URL = getBooksURL + "subject:" + subject;
		URL += "&langRestrict=en&maxResults=" + MAX_RESULTS;
		URL += "&startIndex=" + index + "&key=" + conf.google_key;
		googleClient.get(URL, booksCallback, "json");
	} catch (e) {
		console.log("Google request error:", e.toString());
	}
}

function booksCallback(data) {
	try {
		// extract the book list from google
		bookList = JSON.parse(data);
		console.log( bookList.totalItems + " found on subject " + subject );
		
		if(bookList.totalItems > MAX_RESULTS && !randomIndex) {
			// we have too many results, pick a random starting index
			randomIndex = true;
			var max = Math.min(bookList.totalItems - MAX_RESULTS, 500);
			var i = randomRange(0, max);
			console.log("Start search at index " + i);
			return getBooks(subject, i);
		} else {
			// proceed with the given book list
			randomIndex = false;
			return parseAllBooks();
		}
	} catch (e) {
		console.log("Google callback error:", e.toString());
	}
}

function parseAllBooks() {
	try {
		// check each book to find a suitable one
		bookToTweet = {};
		if(bookList.totalItems > 0 && bookList.hasOwnProperty('items')) {
			var shuffled = shuffle(bookList.items);
			for (var i = 0; i < shuffled.length; i++) {
				parseBook(shuffled[i].volumeInfo);
				if(bookToTweet.hasOwnProperty('title')) break;
			}
		}
		
		if(bookToTweet.hasOwnProperty('title')) {
			// candidate book found, check if we've tweeted it before
			return queryBookDB(bookToTweet);
		} else if (attempts < MAX_ATTEMPTS) {
			// failed to find an appropriate book, choose new subject
			return getNewSubject();
		} else {
			// too many attempts, give up for now
			console.log("Failed to find a book after " + MAX_ATTEMPTS + " attempts.");
		}
	} catch (e) {
		console.log("Book list parsing error:", e.toString());
	}
}

function parseBook(book) {
	try {
		// exit early if a book is already found
		if(bookToTweet.hasOwnProperty('title')) return false;
		
		var title = parseTitle(book);
		if( title.length < 3 || title.length > 50) return false;
		if( isOffensive(title) ) return false;
		
		var author = parseAuthors(book);
		if( author.length < 3 || author.length > 34) return false;
		
		var isbn = parseISBN(book);
		var thumbnail = parseThumbnail(book);
		if( isbn.length < 13 || thumbnail.length < 3) return false;
		if( contains(recentISBNs, isbn) ) return false;
		
		console.log( ">> " + title + " by " + author);
		console.log( ">> " + "ISBN " + isbn );
		console.log( ">> " + "Thumbnail: " + thumbnail);
		
		bookToTweet = { title: title, author: author, isbn: isbn, thumbnail: thumbnail};
		return true;
	} catch (e) {
		console.log("Book parsing error:", e.toString());
	}
}

function parseTitle(book) {
	// ensure the book has a title
	if(book.hasOwnProperty('title')){
		return book.title;
	} else {
		return "";
	}
}

function parseAuthors(book) {
	// turn the author array into a nice string
	if (!book.hasOwnProperty('authors')) {
		return "";
	} else if (book.authors.length == 0) {
		return "";
	} else if (book.authors.length == 1) {
		return book.authors[0];
	} else if (book.authors.length == 2) {
		return book.authors[0] + " & " + book.authors[1];
	} else if (book.authors.length > 2) {
		return book.authors[0] + " et al.";
	} else {
		return "";
	}
}

function parseISBN(book) {
	// find the book's ISBN, if present
	if (book.hasOwnProperty('industryIdentifiers')) {
		for (var i = 0; i < book.industryIdentifiers.length; i++) {
			if (book.industryIdentifiers[i].type == "ISBN_13") {
				return book.industryIdentifiers[i].identifier;
			}
		}
		return "";
	} else {
		return "";
	}
}

function parseThumbnail(book) {
	// extract the URL of the book's thumbnail
	if (book.hasOwnProperty('imageLinks')) {
		if (book.imageLinks.hasOwnProperty('thumbnail')) {
			return book.imageLinks.thumbnail;
		}
	}
	return "";
}

function getThumbnailImage(URL) {
	try {
		// get the book cover from the URL
		var image = request(URL);
		var stream = fs.createWriteStream(BOOK_COVER);
		image.pipe(stream);
		stream.on('close', function() {
			// get the size of the image
			var size = sizeOf(BOOK_COVER);
			if (size.height <= 0) throw "Image height error";
			if (size.width <= 0) throw "Image width error";
			
			// tile the book cover 4 times horizontally
			var test = gm(BOOK_COVER);
			var scale = 220 / size.height;
			test.resize(size.width * scale, size.height * scale, "!");
			
			// tile the cover horizontally if needed
			tile = Math.ceil((size.height * 2.25) / size.width) - 1;
			for (var i = 0; i < tile ; ++i) {
				test.append(BOOK_COVER, true);
			}
			test.noProfile();
			test.write(TILE_COVER, thumbnailCallback);
		});
	} catch (e) {
		console.log("Thumbnail error:", e.toString());
	}
}

function thumbnailCallback(err) {
	if (!err) {
		console.log("Successfully tiled the cover.");
		prepareTweet();
	} else {
		console.log("Thumbnail error:", err);
	}
}

function prepareTweet() {
	try {
		// assemble the tweet
		var message = "A book about " + subject + ": ";
		message += bookToTweet.title + " by " + bookToTweet.author;
		
		// make sure the book cover exists
		if(fs.existsSync(TILE_COVER)) {
			postTweet(message);
		} else {
			throw "Tiled cover image missing.";
		}
		
		// avoid reusing these values
		recentISBNs.push( bookToTweet.isbn );
		recentSubjects.push( subject );
		insertBookDB( bookToTweet );
	} catch (e) {
		console.log("Tweet assembly error:", e.toString());
	}
}

function postTweet(message) {
	try {
		// post a new status to the twitter API
		console.log("Posting tweet:", message);
		if(DO_TWEET) {
			twitterRestClient.statusesUpdateWithMedia({
				'status': message,
				'media[]': TILE_COVER
			}, postCallback);
		}
	} catch (e) {
		console.log("Twitter error:", e.toString());
	}
}

function postCallback(error, result) {
	// twitter API callback from posting tweet
	if (!error) {
		console.log("Post tweet success!");
	}
	else {
		console.log("Post tweet error:", error);
	}
}

function initDB() {
	try {
		// connect to postgres db
		client.connect(function(err) {
			// connected, make sure table exists
			if (err) return console.log('DB init error:', err);
			client.query(DB_CREATE, function(err) {
				// table exists, start tweeting
				if (err) return console.log('DB init error:', err);
				console.log("Database initialized.");
				waitToBegin();
			});
		});
	} catch (e) {
		console.log("DB init error:", e.toString());
	}
}

function queryBookDB(book) {
	try {
		// check if the given book's ISBN exists in the database
		client.query(DB_QUERY, [book.isbn], function(err, result) {
			if (err) {
				return console.error('DB query error:', err);
			} else if (result.rows.length > 0) {
				// we've tweeted this book in the past
				console.log(book.title + " has already been tweeted");
				recentISBNs.push(book.isbn);
				parseAllBooks(); // restart
			} else {
				// book has never been tweeted before, proceed
				console.log(book.title + " has never been tweeted");
				getThumbnailImage(book.thumbnail);
			}
		});
	} catch (e) {
		console.log("DB query error:", e.toString());
	}
}

function insertBookDB(book) {
	try {
		// add the given book's ISBN to the database
		client.query(DB_INSERT, [book.isbn], function(err, result) {
			if (err) return console.error('DB insert error:', err);
		});
	} catch (e) {
		console.log("DB insert error:", e.toString());
	}
}

function contains(array, obj) {
	// convenience function
	for (var i = 0; i < array.length; i++) {
		if (array[i].indexOf(obj) >= 0) {
			return true;
		}
	}
	return false;
}

function randomSeeded() {
	// some deployments don't seed random numbers well
	var d = new Date();
	var s = d.getDate() + d.getHours() + d.getMilliseconds();
	for(var i = s % 30; i < 30 ; i++) Math.random();
	return Math.random();
}

function randomRange(min, max) {
	// random number between min (included) & max (excluded)
	return Math.floor(randomSeeded() * (max - min)) + min;
}

function shuffle(array) {
	// randomly shuffle the given array
	randomSeeded();
	var current = array.length,
		tempValue, rIndex;
	while (0 !== current) {
		// choose a random element
		rIndex = Math.floor(Math.random() * current);
		current -= 1;

		// swap with current
		tempValue = array[current];
		array[current] = array[rIndex];
		array[rIndex] = tempValue;
	}
	return array;
}

function isOffensive(text) {
	// detect any offensive word on the blacklist
	for (var i = 0; i < blacklist.length; i++) {
		if (text.toLowerCase().indexOf( blacklist[i] ) >= 0) {
			console.log( blacklist[i] + " is offensive." );
			return true;
		}
	}
	return false;
}

// start the application by initializing the db connection
initDB();