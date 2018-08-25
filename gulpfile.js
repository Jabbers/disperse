/* Disperse by Fred Steegmans (u/jabman) */
/* npm install --save-dev gulp@next gulp-changed gulp-jscs gulp-uglify gulp-rename */

const path = require('path');
const fs = require('fs-extra');
const glob = require('glob-all');
const del = require('del');
const Vinyl = require('vinyl');
const vinylFtp = require('vinyl-ftp');
const lazypipe = require('lazypipe');
const through2 = require('through2');
const mergeStream = require('merge-stream');
const Concat = require('concat-with-sourcemaps');
const argv = require('yargs').argv;
const config = require('js-yaml').safeLoad(fs.readFileSync('config.yaml', 'utf8'));
const gulp = require('gulp');
const gulpif = require('gulp-if');
const sftp = require('gulp-sftp');
const hb = require('gulp-hb');
const uglify = require('gulp-uglify');
const cleanCSS = require('gulp-clean-css');
const size = require('gulp-size');
const print = require('gulp-print').default;
const printSpaceSavings = require('gulp-print-spacesavings');
const rename = require('gulp-rename');
const changed = require('gulp-changed');

// Gather the domains (sites) affected in this run
const domains = Object.keys(config.sites).filter(function(domain) {
  return argv.site ? (argv.site === domain) : (!!config.sites[domain].active);
});

// Construct array of globs based on matched domains and cli glob
const globs = domains.map(function(domain) {
  return domain + '/**/' + (argv.filter || '*');
});

// Get a list of previously built files
const destFiles = glob.sync('build/*/**/*', { dot: true }).map(function(filePath) {
  return filePath.substr(filePath.indexOf('build/') + 6);
});

// File filters
const is = {
  file: function(file) { return !file.isDirectory(); },
  handlebars: function(file) { return file.extname === '.hbs'; },
  CSS: function(file) { return file.extname === '.css'; },
  JS: function(file) { return file.extname === '.js'; },
  uncompressedJS: function(file) { return file.basename.indexOf('.min.js') === -1; },
  uncompressedCSS: function(file) { return file.basename.indexOf('.min.css') === -1; },
};

// Initialize per-domain package object
let package = domains.reduce((o, key) => ({ ...o, [key]: {}}), {});
let buildFiles = [];

let concatByExtname = lazypipe()
  .pipe(through2.obj,
    function onFile(file, _, cb) {
      if (file.isBuffer()) {
        let domain = file.relative.split(path.sep).shift();
        if (package[domain][file.extname] == null) {
          package[domain][file.extname] = new Concat(true, 'app.min.js');
        }
        package[domain][file.extname].add(file.relative, file.contents);
      }
      cb();
    },
    function onEnd(cb) {
      for (let domain in package) {
        for (let extname in package[domain]) {
          // console.log(package[domain][extname].sourceMap);
          let file = new Vinyl(package[domain][extname]);
          file.path = JSON.parse(package[domain][extname].sourceMap).sources[0];
          file.basename = 'app.min' + extname;
          file.contents = package[domain][extname].content;
          this.push(file);
        }
      }
      cb();
    }
  );

let deleteOrphans = lazypipe()
  .pipe(through2.obj,
    function onFile(file, _, cb) {
      buildFiles.push(file.relative);
      this.push(file);
      cb();
    },
    function onEnd(cb) {
      destFiles.forEach(function(destFile) {
        if (buildFiles.indexOf(destFile) === -1) { // This destFile wasn't in stream
          del(destFile, { cwd: 'build/' });
        }
      });
      cb();
    }
  );

let compressJS = lazypipe()
  .pipe(uglify)
  .pipe(rename, { extname: '.min.js' });

let compressCSS = lazypipe()
  .pipe(cleanCSS, {debug: true, compatibility: 'ie8'})
  .pipe(rename, { extname: '.min.css' });

let buildJS = lazypipe()
  .pipe(printSpaceSavings.init)
  .pipe(function() { return gulpif(is.uncompressedJS, compressJS()) })
  .pipe(printSpaceSavings.print)
  .pipe(concatByExtname);

let buildCSS = lazypipe()
  .pipe(printSpaceSavings.init)
  .pipe(function() { return gulpif(is.uncompressedCSS, compressCSS()) })
  .pipe(printSpaceSavings.print)
  .pipe(concatByExtname);

let buildHTML = lazypipe()
  .pipe(hb, {
    debug: false,
    helpers: [
      'node_modules/handlebars-layouts'
    ],
    partials: [
      'src/layouts/*.hbs',         // general layouts
      'src/partials/*.hbs',        // general partials
    ]
  })
  .pipe(rename, { extname: '.html' });

// gulp-changed comparator using a SHA1 hash cache stored in [domain].json files
let compareHashCache = function (stream, source, targetPath) {
  let domain = source.path.match(RegExp('build/([^/]+)')).pop();
  if (package[domain].cache == null) {
    // Set cacheId to child dir
    let cachePath = path.join('cache', domain + '.json');
    package[domain].cache = fs.readJsonSync(cachePath, {throws: false}) || {};
    stream.setMaxListeners(50);
    stream.once('end', function() {
      fs.writeFileSync(cachePath, JSON.stringify(package[domain].cache, null, 2));
    });
  }
  let relativeSourcePath = source.path.match(RegExp('build/?(.+)$')).pop();
  let hashNew = crypto.createHash('sha1').update(source.contents).digest('hex');
  if (hashNew !== package[domain].cache[relativeSourcePath]) {
    stream.push(source);
    package[domain].cache[relativeSourcePath] = hashNew;
  }
  return Promise.resolve();
};


function build() {

  return gulp.src(globs, { base: 'src/sites/', cwd: 'src/sites/', dot: true })
    .pipe(gulpif(is.handlebars, buildHTML()))
    .pipe(gulpif(is.JS, buildJS()))
    .pipe(gulpif(is.CSS, buildCSS()))
    .pipe(gulpif(!argv.filter, deleteOrphans()))
    //.pipe(print())
    .pipe(gulpif(is.file, changed('build/', { hasChanged: changed.compareContents })))
    // .pipe(size({ showFiles: false }))
    .pipe(gulp.dest('build/'));

}

function deploy() {

  return mergeStream(domains.map(function(domain) {
    let defaultSite = {
      host: 'ftp.' + domain,
      parallel: 4,
      maxConnections: 20,
      log: console.log,
    };
    let site = Object.assign(defaultSite, config.sites[domain]);

    switch (site.protocol) {
      case 'ftp':
        var conn = vinylFtp.create(site);
        return gulp.src(globs, { base: 'build/', cwd: 'build/', dot: true, buffer: false })
          .pipe(conn.differentSize(site.remotePath))
          .pipe(conn.dest(site.remotePath));

      case 'sftp':
        return gulp.src(globs, { base: 'build/', cwd: 'build/', dot: true })
          .pipe(gulpif(is.file, changed('build/', { hasChanged: compareHashCache })))
          .pipe(sftp(site));
    }
  }));

}


exports.default = exports.build = build;
exports.deploy = deploy;
