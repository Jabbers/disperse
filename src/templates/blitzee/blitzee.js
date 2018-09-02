/*
Blitzee by beehive /u/jabman

- A minimalist mobile-first web app framework
- Quick setup: no building required, edit config & done
- Light-weight: SPA using only Onsen UI & vanilla JS (no libraries or jquery)
- Low maintenance: always loads latest version of Onsen (CDN)

Setup

1. Edit options (index.html line 7), along with <title> and <meta> descr above
2. For reference, here's how the options should look:
      var options = {
        urlRoot: 'https://yourdomain.com/',
        analyticsEnabled: true,
        analyticsId: 'UA-',
        homePageIndex: 0,
        pageUrls: ['home', 'our-services', 'about-us'],
        pageTitles: ['My Site - This how we do', 'X to the Z', 'About Us']
      };
3. Site consists of a menu and pages: first edit the menu (index.html line 35)
4. Put page content in <template id="tpl-about-us"><page id="about-us"> tags
5. That's it. You shouldn't (need to) touch anything in this file, by the way
*/

var blitzee = (function (options) {

  var isLocal = document.location.href.indexOf('file://') > -1;

  console.log('blitzee v0.6.4 by beehive (u/jabman)');

  // Load Google Analytics & send a pageview
  if (options.analyticsEnabled && !isLocal) {
    initializeAnalytics();
  }

  // Set initial page if/when DOMContentloaded
  if (/complete|interactive|loaded/.test(document.readyState)) {
    setInitialPage();
  } else {
    document.addEventListener("DOMContentLoaded",  setInitialPage);
  }

  // Listen for Onsen's (page) init event to trigger onPageLoad()
  document.addEventListener('init', onPageLoad);

  // The popstate event is only triggered by performing a browser action, such as clicking
  // on the back button (or calling history.back() in JavaScript), when navigating between
  // two history entries for the same document.
  window.onpopstate = showInitialPage;

  // Setting document-level event handlers
  // Alternatively, use onclick="blitzee.goPage('contact')"
  document.addEventListener('click', function (event) {
    var elHref = event.target.closest('[href]');
    if (elHref) {
      var elMenu = elHref.closest('ons-splitter-side');
      var href = elHref.getAttribute('href');
      var slash = href.lastIndexOf('/');
      var stub = slash === -1 ? href : href.substring(slash + 1);
      // Catch page link clicks
      for (var i = 0; i < options.pageUrls.length; i++) {
        if (options.pageUrls[i] == stub) {
          event.preventDefault();
          goPage(stub).then(function() { return elMenu ? elMenu.close() : false }); // goes to homepage if stub is '', or 'home', or 0
          return false;
        }
      }
    }
    // No reason to interfere; Carry on with the default
    return;
  }, false);

  // Onsen is fully loaded:
  ons.ready(function () {
    console.log('onsen ready');
    ons.disableIconAutoPrefix();
    var nav = document.getElementById('myNavigator');

    // nav.catch(function(err) { options.debug && console.log(err); });

    nav.bringPageTop(nav.page)
      .catch(function(err) { options.debug && console.log(err); });
    if (options.analyticsEnabled && !isLocal) {
      var isHomepage = (nav.page == 'tpl-' + options.pageUrls[options.homePageIndex]);
      sendPageViewAnalytics(isHomepage ? '' : nav.page.replace('tpl-', ''));
    }
    // Hide modals onclick
    document.querySelector('ons-modal').onclick = function() { this.hide(); };
    // Theme switchin' across the universe.. on the Starship Enterprise, under capt'n Kirk
    document.getElementById('switchStyle').addEventListener('change', switchTheme);
    initializeTheme();
  });

  // Exposing public methods through return statement. Public/private methods are below.
  return {
    goPage: goPage,
    submitForm: submitForm,
    showActionSheet: showActionSheet,
    showMenu: function() { document.getElementById('menu').open(); },
    closeMenu: function() { document.getElementById('menu').close(); },
    setActiveTab: function(tpl) {
      var index = options.pageUrls.indexOf(tpl.replace('tpl-', ''));
      document.getElementById('tabbar').setActiveTab(index);
    },
    showModal: function(el) {
      var src = el.getAttribute('src').replace('-th', '');
      document.querySelector('ons-modal img').setAttribute('src', src);
      document.querySelector('ons-modal').show();
    },
    closeModal: function() { document.querySelector('ons-modal').hide(); },
  };

  // Public methods (exposed through return statement)
  function goPage(page) { // -1 for back
    var nav = document.getElementById('myNavigator');
    var homeStub = options.pageUrls[options.homePageIndex];
    if (page === 0 || page === 'home') {
      page = '';
    }
    if (page === -1 && history.notOnLandingPage) {
      history.go(-1);
      return nav.popPage()
        .then(function(pg) { // returns a thenable promise
          var pageNew = pg.getAttribute('id') == homeStub ? '' : pg.getAttribute('id');
          if (options.analyticsEnabled && !isLocal) {
            sendPageViewAnalytics(pageNew);

          }
        })
        .catch(function(err) { options.debug && console.log(err); });
    } else {
      page = (page === -1 || page === homeStub) ? '' : page; // -1 means homePage's pageUrl
      if (!isLocal) {
        history.pushState({page: page}, '', '/' + page);
      }
      history.notOnLandingPage = true;
      if (options.analyticsEnabled && !isLocal) {
        sendPageViewAnalytics(page);
      }
      return nav.bringPageTop('tpl-' + (page || homeStub))
        .catch(function(err) { options.debug && console.log(err); }); // returns a thenable promise
    }
  }

  function showActionSheet(title, data) {
    // takes data { 'Bitstamp Help': [ { label: 'How to buy Bitcoin?', icon: 'md-link', href: '' }, ..], ..}
    data[title].push({
      label: 'Close',
      icon: 'md-close'
    });
    ons.openActionSheet({
      title: title,
      cancelable: true,
      buttons: data[title]
    }).then(function (index) {
      if (data[title][index].href) {
        window.open(data[title][index].href);
      }
    });
  }

  // Private methods
  function gtag() {
    (window.dataLayer || []).push(arguments); // for analytics, from google
  }

  function setInitialPage(event) {
    console.log('setting page');
    var nav = document.getElementById('myNavigator');
    nav.page = 'tpl-' + options.pageUrls[options.homePageIndex]; // default
    // Catch /ons-aanbod or #ons-aanbod
    var pageStr = window.location.pathname || window.location.hash;
    // See if it refers to an existing page and set it
    if (pageStr && options.pageUrls.indexOf(pageStr.substr(1)) > -1) {
      nav.page = 'tpl-' + pageStr.substr(1);
    }
  }

  // (Re)fires the nav's pageshow (to ensure browser back/fwd functionality
  function showInitialPage(event) {
    var page = history.state ? history.state.page : null;
    var nav = document.getElementById('myNavigator');
    nav.bringPageTop('tpl-' + (page || options.pageUrls[options.homePageIndex]))
      .catch(function(err) { options.debug && console.log(err); });
  }

  // Used as an event callback i.e. onsubmit="blitzee.onSubmit"
  function submitForm(elem) {
    var XHR = new XMLHttpRequest();
    // Bind the FormData object and the form element ('this' in this context)
    var FD = new FormData(elem.closest('form'));
    // Define what happens on successful data submission
    XHR.addEventListener("load", function(ev) {
      var res = JSON.parse(ev.target.responseText);
      var title = (ev.target.status == 201 ? 'Success' : 'Failed');
      ons.notification.alert(res.message, { title: title, cancelable: true });
    });
    // Define what happens in case of error
    XHR.addEventListener("error", function(ev) {
      var res = JSON.parse(ev.target.responseText);
      ons.notification.alert(res.message, { title: 'Failed', cancelable: true });
    });
    console.log('sending');
    // Set up our request
    XHR.open("POST", options.formPostUrl);
    // The data sent is what the user provided in the form
    XHR.send(FD);
  }

  function onPageLoad(event) {
    var page = event.target;
    if (page.id) {
      var index = options.pageUrls.indexOf(page.id);
      console.log('initializing page ' + index + ': ' + page.id);
      // Run functions defined in options.pageScripts
      if (typeof options.pageScripts[page.id] == 'function') {
        options.pageScripts[page.id]();
      }
      // For homepage, use: if (page.id  === options.pageUrls[options.homePageIndex]) {}
    }
  }

  function initializeAnalytics() {
    // Call google's script dynamically
    var firstel = document.getElementsByTagName('script')[0];
    var gel = document.createElement('script');
    gel.src = 'https://www.googletagmanager.com/gtag/js?id=' + options.analyticsId;
    firstel.parentNode.insertBefore(gel, firstel);
    gtag('js', new Date()); // gtag's a private function adapted from google's snippet
    gtag('config', options.analyticsId, { 'send_page_view': false });
  }

  function sendPageViewAnalytics(page) {
    gtag('event', 'page_view', {
      'page_title': options.pageTitles[options.pageUrls.indexOf(page) === -1 ? options.homePageIndex : options.pageUrls.indexOf(page)],
      'page_location': options.urlRoot + page,
      'page_path': '/' + page
    });
  }

  function switchTheme(event) {
    document.body.classList.toggle('sunshine');
    document.body.classList.toggle('darkness');
    // event.value is true for Sunshine
    document.querySelector('link[title=Sunshine]').disabled = !event.value;
    localStorage.setItem("style", event.value ? "Sunshine" : "Darkness");
  }

  function initializeTheme(event) {
    if (localStorage.getItem('style') == 'Sunshine') {
      document.querySelector('link[title=Sunshine]').disabled = false;
      document.body.classList.toggle('sunshine');
      document.body.classList.toggle('darkness');
      document.getElementById('switchStyle').checked = true;
    }
  }
});

// Polyfills
if (!Element.prototype.matches) {
  Element.prototype.matches = Element.prototype.msMatchesSelector ||
    Element.prototype.webkitMatchesSelector;
}
if (!Element.prototype.closest) {
  Element.prototype.closest = function(s) {
      var el = this;
      if (!document.documentElement.contains(el)) return null;
      do {
          if (el.matches(s)) return el;
          el = el.parentElement || el.parentNode;
      } while (el !== null && el.nodeType === 1);
      return null;
  };
}