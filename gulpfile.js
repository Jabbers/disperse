/* Disperse by Fred Steegmans (u/jabman) */

const gulp = require('gulp');
const gulpif = require('gulp-if');
const data = require('gulp-data');
const sftp = require('gulp-sftp');
const hb = require('gulp-hb');
const uglify = require('gulp-uglify');
const cleanCSS = require('gulp-clean-css');
const htmlmin = require('gulp-htmlmin');
const rename = require('gulp-rename');
const changed = require('gulp-changed');
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
const fancyLog = require('fancy-log');
const prettyBytes = require('pretty-bytes');
const chalk = require('chalk');
const argv = require('yargs').argv;
const config = require('js-yaml').safeLoad(fs.readFileSync('config.yaml', 'utf8'));

// Gather the domains (sites) affected in this run
const domains = Object.keys(config.sites)
  .filter((domain) => {
    return argv.site ? (argv.site === domain) : (!!config.sites[domain].active);
  });

// Construct array of globs based on matched domains and cli glob
const globs = domains
  // Start out with site template paths.
  .reduce((res, domain) => {
    let tpl = config.sites[domain].template;
    let tplPath = `templates/${tpl}/**/*.!(hbs)`;
    if (tpl && res.indexOf(tplPath) < 0) {
      res.push(tplPath);
    }
    return res;
  }, [])
  // Tack on source files for selected sites
  .concat(domains.map((domain) => {
    return `sites/${domain}/**/${argv.filter || '*'}`;
  }));

// Get a list of previously built files
const destFiles = glob.sync('build/*/**/*', { dot: true })
  .map((filePath) => {
    return filePath.substr(filePath.indexOf('build/') + 6);
  });

// File filters
const is = {
  file: (file) => !file.isDirectory(),
  template: (file) => file.path.indexOf('templates/') !== -1,
  handlebars: (file) => file.extname === '.hbs',
  deflatable: (file) => {
    let isInflated = file.basename.indexOf('.min.') === -1;
    return (['.html', '.js', '.css'].indexOf(file.extname) !== -1 && isInflated);
  },
  packable: (file) => ['.js', '.css'].indexOf(file.extname) !== -1,
  HTML: (file) => file.extname === '.html',
  JS: (file) => file.extname === '.js',
  CSS: (file) => file.extname === '.css',
};

// Initialize per-domain package object
let package = domains.reduce((o, key) => ({ ...o, [key]: {}}), {});
let logged = Object.create(package);
let buildFiles = [];

let concatByExtname = lazypipe()
  .pipe(through2.obj,
    function onFile(file, _, cb) {
      if (file.isBuffer()) {
        let domain = file.relative.split(path.sep).shift();
        let ext = file.extname;
        if (package[domain][ext] == null) {
          package[domain][ext] = new Concat(true, `app.min${ext}`);
          package[domain][ext].originalSize = 0;
        }
        package[domain][ext].add(file.relative, file.contents);
        package[domain][ext].originalSize += file.originalSize;
      }
      cb();
    },
    function onEnd(cb) {
      for (let domain in package) {
        for (let extname in package[domain]) {
          let file = new Vinyl({
            // contents: package[domain][extname],
            path: 'src/sites/' + JSON.parse(package[domain][extname].sourceMap).sources[0],
            base: 'src/sites/',
            basename: 'app.min' + extname,
            contents: package[domain][extname].content,
          });
          file.originalSize = package[domain][extname].originalSize;
          this.push(file);
        }
      }
      cb();
    }
  );

// Assign cloned copies of a template file to each site using it
let assignTemplate = lazypipe()
  .pipe(through2.obj,
    function onFile(file, _, cb) {
      if (file.isBuffer()) {
        // file.relative comes in as '../templates/' due to glob.src base
        let template = file.relative.split(path.sep)[2];
        for (let domain of domains) {
          if (config.sites[domain].template === template) {
            let clone = file.clone();
            clone.path = clone.path.replace(`templates/${template}`, `sites/${domain}`);
            clone.base = 'src/sites/';
            this.push(clone);
          }
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

let deflateByExtname = lazypipe()
  .pipe(() => gulpif(is.HTML, htmlmin({ collapseWhitespace: true })))
  .pipe(() => gulpif(is.JS, uglify()))
  .pipe(() => gulpif(is.CSS, cleanCSS({ debug: true })));

let buildHTML = lazypipe()
  .pipe(data, (file, cb) => {
    let domain = file.relative.split('/').shift();
    // Always expose config and current domain name
    cb(null, Object.assign(config.sites[domain], { domain: domain }));
  })
  .pipe(hb, {
    debug: false,
    helpers: [
      'node_modules/handlebars-layouts'
    ],
    partials: [
      'src/templates/*/*.hbs',     // template layouts
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

let log = {
  record: lazypipe()
    .pipe(through2.obj, (file, _, cb) => {
      file.originalSize = file.contents.length;
      cb(null, file);
    }),
  report: lazypipe()
    .pipe(through2.obj, (file, _, cb) => {
      let strChange = '';
      if (file.originalSize !== file.contents.length) {
        let pct = 100 * (file.contents.length - file.originalSize) / file.originalSize;
        strChange = '(' + (pct > 0 ? '+' : '') + pct.toFixed().padStart(2) + '%)';
      }
      let strSize = prettyBytes(file.contents.length);
      let domain = file.relative.split(path.sep)[0];
      let domainColor = logged[domain] === true ? 'grey' : 'green';
      let strDomain = chalk[domainColor](domain + path.sep);
      let strFile = chalk.green(file.basename);
      fancyLog(strSize.padEnd(9), strChange.padStart(6), strDomain + strFile);
      logged[domain] = true;
      cb(null, file);
    }),
};

// Build task
function build() {
  return gulp.src(globs, { base: 'src/sites/', cwd: 'src/', dot: true })
    .pipe(log.record())
    .pipe(gulpif(is.template, assignTemplate()))
    .pipe(gulpif(is.handlebars, buildHTML()))
    .pipe(gulpif(is.deflatable, deflateByExtname()))
    .pipe(gulpif(is.packable, concatByExtname()))
    // .pipe(print())
    .pipe(gulpif(!argv.filter, deleteOrphans()))
    .pipe(log.report())
    .pipe(gulpif(is.file, changed('build/', { hasChanged: changed.compareContents })))
    //.pipe(size({ showFiles: false }))
    .pipe(gulp.dest('build/'));
}

// Deploy task
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
