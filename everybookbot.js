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

var postingTweet = false;
var postTweetDone = false;

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

function checkTime() {
	// heroku scheduler runs every hour on :30
	// schedule new tweet every 8 hours
	var d = new Date();
	var hours = d.getHours() % 8;
	console.log("Wait " + hours + " hours for next tweet");
	if (hours == 0 || !DO_TWEET)
		startNewTweet();
	else
		process.exit(0);
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
			request(getNounsURL, subjectCallback);
		}
	} catch (e) {
		console.log("Wordnik request error:", e.toString());
	}
}

function subjectCallback (err, resp, body) {
	try {
		// add all the new words to the local cache
		var words = JSON.parse(body);
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
		var args = {headers: { "Content-Type": "application/json"}};
		var URL = getBooksURL + "subject:" + subject;
		URL += "&langRestrict=en&maxResults=" + MAX_RESULTS;
		URL += "&startIndex=" + index + "&key=" + conf.google_key;
		googleClient.get(URL, args, booksCallback);
	} catch (e) {
		console.log("Google request error:", e.toString());
	}
}

function booksCallback(data, response) {
	try {
		// extract the book list from google
		bookList = data;
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
			// book found
			return getThumbnailImage(bookToTweet.thumbnail);
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
		if (title.length < 3 || isOffensive(title)) return false;
		if (isNotEnglish(title)) return false;
		
		var author = parseAuthors(book);
		if (author.length < 3) return false;
		
		if (subject.length + title.length + author.length > 90) return false;
		
		var year = parseYear(book);
		if (year.length !== 4 || !/\d{4}/.test(year)) return false;
		if (parseInt(year) > new Date().getFullYear()) return false;
		
		var isbn = parseISBN(book);
		var thumbnail = parseThumbnail(book);
		if (isbn.length < 13 || thumbnail.length < 3) return false;
		if (contains(recentISBNs, isbn)) return false;
		
		console.log( ">> " + title + " by " + author);
		console.log( ">> " + "Published " + year);
		console.log( ">> " + "ISBN " + isbn );
		console.log( ">> " + "Thumbnail: " + thumbnail);
		
		bookToTweet = {
			title: title,
			author: author,
			year: year,
			isbn: isbn,
			thumbnail: thumbnail
		};
		return true;
	} catch (e) {
		console.log("Book parsing error:", e.toString());
	}
}

function parseTitle(book) {
	// ensure the book has a title
	if (book.hasOwnProperty('title')) {
		return book.title;
	}
	return "";
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

function parseYear(book) {
	// extract the year published
	if (book.hasOwnProperty('publishedDate')) {
		return book.publishedDate.substring(0, 4);
	}
	return "";
}

function parseISBN(book) {
	// find the book's ISBN, if present
	if (book.hasOwnProperty('industryIdentifiers')) {
		for (var i = 0; i < book.industryIdentifiers.length; i++) {
			if (book.industryIdentifiers[i].type == "ISBN_13") {
				return book.industryIdentifiers[i].identifier;
			}
		}
	}
	return "";
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
		message += " (" + bookToTweet.year + ")";
		
		// make sure the book cover exists
		if(fs.existsSync(TILE_COVER)) {
			postTweet(message);
		} else {
			throw "Tiled cover image missing.";
		}
		
		// avoid reusing these values
		recentISBNs.push( bookToTweet.isbn );
		recentSubjects.push( subject );
	} catch (e) {
		console.log("Tweet assembly error:", e.toString());
	}
}

function postTweet(message) {
	try {
		// post a new status to the twitter API
		console.log("Posting tweet:", message);
		if(DO_TWEET && !postingTweet) {
			postingTweet = true;
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
		postTweetDone = true;
		process.exit(0);
	}
	else {
		console.log("Post tweet error:", error);
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

function isNotEnglish(text) {
	// does the given text contain non-english characters?
	if (text == null) return false;
	
	// Cyrillic characters
	if (/[\u0400-\u04FF]/.test(text)) return true;
	
	// Japanese characters
	if (/[\u3040-\u309F]/.test(text)) return true;
	if (/[\u30A0-\u30FF]/.test(text)) return true;
	if (/[\uFF00-\uFF9F]/.test(text)) return true;
	if (/[\u4E00-\u9FAF]/.test(text)) return true;
	
	// Chinese characters
	if (/[\u4E00-\u9FFF]/.test(text)) return true;
	if (/[\u3400-\u4DFF]/.test(text)) return true;
	if (/[\uF900-\uFAFF]/.test(text)) return true;
	
	// Korean characters
	if (/[\uAC00-\uD7AF]/.test(text)) return true;
	
	return false;
}

// start the application
checkTime();
