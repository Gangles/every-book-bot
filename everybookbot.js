var fs = require('fs');
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

// import rest client: https://github.com/aacerox/node-rest-client
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
	console.error("There was an error opening the blacklist file:");
	console.log(err);
	process.exit(1);
}

// wordnik API information
var getNounsURL = "http://api.wordnik.com/v4/words.json/randomWords?"
+ "minCorpusCount=4000&minDictionaryCount=20&hasDictionaryDef=true&" +
+ "excludePartOfSpeech=proper-noun-posessive,suffix,family-name,idiom,affix&"
+ "includePartOfSpeech=noun,proper-noun&limit=1&maxLength=12&api_key=" + conf.wordnik_key;

// google books API information
var getBooksURL = "https://www.googleapis.com/books/v1/volumes?q=";

// global bot variables
var subject = "";
var bookToTweet = {};

var BOOK_COVER = './tmp/cover.jpg';
var TILE_COVER = './tmp/cover_tiled.jpg';

var recentISBNs = [];
var recentSubjects = [];
var MAX_MEMORY = 300;

var attempts = 0;
var MAX_ATTEMPTS = 30;
var DO_TWEET = true;

function startNewTweet() {
	try {
		// reset global variables
		subject = "";
		bookToTweet = {};
		attempts = 0;
		
		// limit how long before books/subjects can be reused
		while (recentISBNs.length > MAX_MEMORY) recentISBNs.shift();
		while (recentSubjects.length > MAX_MEMORY) recentSubjects.shift();
	
		// delete any leftover cover images
		if(fs.existsSync(BOOK_COVER)) fs.unlinkSync(BOOK_COVER);
		if(fs.existsSync(TILE_COVER)) fs.unlinkSync(TILE_COVER);
	
		// get a new random subject
		getSubject();
	} catch (e) {
		console.log("Initial setup error:", e.toString());
	}
}

function getSubject() {
	try {
		// ask wordnik for a random word
		restClient.get(getNounsURL, subjectCallback, "json");
	} catch (e) {
		console.log("Wordnik request error:", e.toString());
	}
}

function subjectCallback(data) {
	try {
		// use this random word as a subject
		var words = JSON.parse(data);
		subject = words[0].word;
		
		if(contains(recentSubjects, subject)) {
			// we've used this subject recently
			console.log(subject + " used recently, get new subject.")
			getSubject();
		} else if(isOffensive(subject)) {
			// bad word filter found a match
			console.log(subject + " is offensive, get new subject.")
			getSubject();
		} else {
			// get books for this subject
			console.log("Look up books for: " + subject);
			getBooks(subject);
		}
	} catch (e) {
		console.log("Wordnik callback error:", e.toString());
	}
}

function getBooks(subject) {
	try {
		// ask google for some books on the given subject
		var URL = getBooksURL + "subject:" + subject;
		URL += "&langRestrict=en&maxResults=30&key=" + conf.google_key;
		googleClient.get(URL, booksCallback, "json");
	} catch (e) {
		console.log("Google request error:", e.toString());
	}
}

function booksCallback(data) {
	try {
		// iterate through given books to find an appropriate one
		var books = JSON.parse(data);
		console.log( books.totalItems + " found on subject " + subject );
		if(books.totalItems > 0) {
			for (var i = 0; i < books.items.length; i++) {
				parseBook(books.items[i].volumeInfo);
				if(bookToTweet.hasOwnProperty('title')) break;
			}
		}
		
		if(bookToTweet.hasOwnProperty('title')) {
			// appropriate book found, get the thumbnail
			getThumbnailImage(bookToTweet.thumbnail);
		} else if (attempts < MAX_ATTEMPTS) {
			// failed to find an appropriate book, choose new subject
			++ attempts;
			getSubject();
		} else {
			console.log("Failed to find a book after " + MAX_ATTEMPTS + "attempts.");
		}
	} catch (e) {
		console.log("Google callback error:", e.toString());
	}
}

function parseBook(book) {
	try {
		// exit early if a book is already founds
		if(bookToTweet.hasOwnProperty('title')) return false;
		
		var title = parseTitle(book);
		if( title.length < 3 || title.length > 50) return false;
	
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
			// tile the book cover 4 times horizontally
			var test = gm(BOOK_COVER);
			test.resize(null, 220);
			test.append(BOOK_COVER, BOOK_COVER, BOOK_COVER, true);
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

function contains(array, obj) {
	// convenience function
	for (var i = 0; i < array.length; i++) {
		if (array[i].indexOf(obj) >= 0) {
			return true;
		}
	}
	return false;
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

// post a tweet as soon as we run the program
startNewTweet();

// post again every 60 minutes
setInterval(startNewTweet, 1000 * 60 * 60);