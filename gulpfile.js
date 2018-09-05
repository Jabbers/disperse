/* Disperse by Fred Steegmans (u/jabman) */

const path = require('path');
const fs = require('fs-extra');
const gulp = require('gulp');
const gulpif = require('gulp-if');
const changed = require('gulp-changed');
const lazypipe = require('lazypipe');
const through2 = require('through2');
const fancyLog = require('fancy-log');
const prettyBytes = require('pretty-bytes');
const chalk = require('chalk');
const argv = require('yargs').argv;
const jsYaml = require('js-yaml');
const config = jsYaml.safeLoad(fs.readFileSync('config.yaml', 'utf8'));
// const print = require('gulp-print').default; // used for debugging

// Build task dependencies
const data = require('gulp-data');
const hb = require('gulp-hb');
const uglify = require('gulp-uglify');
const cleanCSS = require('gulp-clean-css');
const htmlmin = require('gulp-htmlmin');
const rename = require('gulp-rename');
const globAll = require('glob-all');
const del = require('del');
const Vinyl = require('vinyl');
const Concat = require('concat-with-sourcemaps');

// Deploy task dependencies
const crypto = require('crypto');
const mergeStream = require('merge-stream');
const vinylFtp = require('vinyl-ftp');
const sftp = require('gulp-sftp');

// Main gulp tasks are declared first, followed by their subroutines & helpers

// Build task
function build() {
  // Construct globs matching domains and their templates for processing
  let globsIn = domains
    .reduce((res, domain) => {
      let tpl = config.sites[domain].template;
      let excl = ['layout.hbs', 'README*', 'LICENSE', 'package*.json', '.git*'];
      let tplPath = `templates/${tpl}/**/!(${excl.join('|')})`;
      if (tpl && res.indexOf(tplPath) < 0) {
        res.push(tplPath);
      }
      return res;
    }, [])
    .concat(domainGlobs.map(glob => `sites/${glob}`));

  // The build task detects changes in files by comparing their contents
  let changedOptions = { hasChanged: changed.compareContents };

  // Get a list of previously built files
  log.builtPrev = globAll('build/*/**/*', { dot: true }, (err, files) => {
    log.builtPrev = files.map(filePath => {
      return filePath.substr(filePath.indexOf('build/') + 6);
    });
  });

  // Return a piped stream -- you go gulp
  return gulp
    .src(globsIn, { base: 'src/sites/', cwd: 'src/', dot: true })
    .pipe(log.record())
    .pipe(gulpif(is.template, assignTemplate()))
    .pipe(gulpif(is.handlebars, buildHTML()))
    .pipe(gulpif(is.deflatable, deflateByExtname()))
    .pipe(gulpif(is.packable, concatByExtname()))
    .pipe(gulpif(!argv.filter, deleteOrphans()))
    .pipe(log.built())
    .pipe(gulpif(is.file, changed('build/', changedOptions)))
    .pipe(gulp.dest('build/'));
}

// Deploy task
function deploy() {
  return mergeStream(
    domains.map(domain => {
      let defaultSite = {
        host: 'ftp.' + domain,
        parallel: 4,
        maxConnections: 20,
        log: log.deployed(domain)
      };
      let site = Object.assign(defaultSite, config.sites[domain]);
      let srcOptions = { cwd: 'build/' + domain, dot: true };
      let changedOptions = { hasChanged: compareHashCache };

      switch (site.protocol) {
        case 'ftp': {
          let conn = vinylFtp.create(site);
          return gulp
            .src('**/*', Object.assign(srcOptions, { buffer: false }))
            .pipe(log.record()) // reporting is done by our vinyl-ftp logger
            .pipe(conn.differentSize(site.remotePath))
            .pipe(conn.dest(site.remotePath));
        }
        case 'sftp': {
          return gulp
            .src(domainGlobs, srcOptions)
            .pipe(gulpif(is.file, changed('build/', changedOptions)))
            .pipe(sftp(site));
        }
      }
    })
  );
}

// Gather the domains (sites) affected in this run
const domains = Object.keys(config.sites).filter(domain => {
  return argv.site ? argv.site === domain : !!config.sites[domain].active;
});

// Construct globs matching all files for processing (task-agnostic)
const domainGlobs = domains.map(domain => `${domain}/**/${argv.filter || '*'}`);

// File filters
const is = {
  file: file => !file.isDirectory(),
  HTML: file => file.extname === '.html',
  JS: file => file.extname === '.js',
  CSS: file => file.extname === '.css',
  template: file => file.path.indexOf('templates/') > -1,
  handlebars: file => file.extname === '.hbs',
  packable: file => ['.js', '.css'].indexOf(file.extname) > -1,
  deflatable: file => {
    let isInflated = file.basename.indexOf('.min.') === -1;
    return ['.html', '.js', '.css'].indexOf(file.extname) > -1 && isInflated;
  }
};

// Common globals
let package = domains.reduce((res, domain) => ({ ...res, [domain]: {} }), {});
let log = { builtNow: [], builtPrev: {}, fileMeta: {} };
log.logged = Object.create(package);

log.record = lazypipe().pipe(
  through2.obj,
  (file, _, cb) => {
    file.originalSize = file.stat.size;
    let pos = file.path.search(/\/(sites|build)\//g);
    if (pos !== -1) {
      let [domain, relative] = file.path.substring(pos + 7).split(path.sep, 2);
      let metadata = { [relative]: file.originalSize };
      log.fileMeta[domain] = Object.assign({}, log.fileMeta[domain], metadata);
    }
    cb(null, file);
  }
);

log.built = lazypipe().pipe(
  through2.obj,
  function onFile(file, _, cb) {
    let strChange = '';
    if (file.originalSize !== file.contents.length) {
      let sizeDiff = file.contents.length - file.originalSize;
      let pct = (100 * sizeDiff) / file.originalSize;
      strChange = `(${pct > 0 ? '+' : ''}${pct.toFixed().padStart(2)}%)`;
    }
    let strSize = prettyBytes(file.contents.length);
    let domain = file.relative.split(path.sep)[0];
    let domainColor = log.logged[domain] === true ? 'grey' : 'green';
    let strDomain = chalk[domainColor](domain + path.sep);
    let strFile = chalk.green(file.basename);
    fancyLog(strSize.padEnd(9), strChange.padStart(6), strDomain + strFile);
    log.logged[domain] = true;
    cb(null, file);
  },
  function onEnd(cb) {
    domains.forEach(domain => (log.logged[domain] = false));
    cb();
  }
);

// This returns a domain-specific logger function tailored to vinyl-ftp
log.deployed = domain => {
  return (...args) => {
    if (args[0].trim() === 'UP') {
      let domainColor = log.logged[domain] === true ? 'grey' : 'green';
      let strDomain = chalk[domainColor](domain + path.sep);
      let [progress, filePath] = args[1].trim().split(' ');
      let omitFrom = (config.sites[domain].remotePath || '').length + 1;
      let remoteRelative = filePath.substring(omitFrom);
      let strFile = chalk.green(remoteRelative);
      let strChange = `(${progress})`;
      let fileSize = log.fileMeta[domain][remoteRelative] || 0;
      let strSize = prettyBytes((fileSize * parseFloat(progress)) / 100);
      fancyLog(strSize.padEnd(9), strChange.padStart(6), strDomain + strFile);
      log.logged[domain] = true;
    }
  };
};

// Build task subroutines & helpers

let concatByExtname = lazypipe().pipe(
  through2.obj,
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
        let concatObj = package[domain][extname];
        let file = new Vinyl({
          path: 'src/sites/' + JSON.parse(concatObj.sourceMap).sources[0],
          base: 'src/sites/',
          basename: 'app.min' + extname,
          contents: concatObj.content
        });
        file.originalSize = concatObj.originalSize;
        this.push(file);
      }
    }
    cb();
  }
);

// Assign cloned copies of a template file to each site using it
let assignTemplate = lazypipe().pipe(
  through2.obj,
  function onFile(file, _, cb) {
    if (file.isBuffer()) {
      // file.relative comes in as '../templates/' due to glob.src base
      let tpl = file.relative.split(path.sep)[2];
      for (let domain of domains) {
        if (config.sites[domain].template === tpl) {
          let out = file.clone();
          out.path = out.path.replace(`templates/${tpl}`, `sites/${domain}`);
          out.base = 'src/sites/';
          this.push(out);
        }
      }
    }
    cb();
  }
);

let deleteOrphans = lazypipe().pipe(
  through2.obj,
  function onFile(file, _, cb) {
    log.builtNow.push(file.relative);
    this.push(file);
    cb();
  },
  function onEnd(cb) {
    let deleteFiles = () => {
      log.builtPrev.forEach(prevFile => {
        // This prevFile wasn't in the stream
        if (log.builtNow.indexOf(prevFile) === -1) {
          del(prevFile, { cwd: 'build/' });
        }
      });
      return cb();
    };
    if (Array.isArray(log.builtPrev)) {
      deleteFiles();
    } else {
      log.builtPrev.on('end', deleteFiles);
    }
  }
);

let deflateByExtname = lazypipe()
  .pipe(() => gulpif(is.HTML, htmlmin()))
  .pipe(() => gulpif(is.JS, uglify()))
  .pipe(() => gulpif(is.CSS, cleanCSS({ debug: true })));

let buildHTML = lazypipe()
  .pipe(
    data,
    (file, cb) => {
      let domain = file.relative.split('/').shift();
      // Always expose config and current domain name
      cb(null, Object.assign(config.sites[domain], { domain: domain }));
    }
  )
  .pipe(
    hb,
    {
      debug: false,
      helpers: ['node_modules/handlebars-layouts'],
      partials: [
        'src/templates/*/*.hbs', // template layouts
        'src/partials/*.hbs' // general partials
      ]
    }
  )
  .pipe(
    rename,
    { extname: '.html' }
  );

// Deploy task subroutines & helpers

// Comparator function for gulp-changed: a SHA1 cache stored in [domain].json
let compareHashCache = (stream, source) => {
  let domain = source.path.match(RegExp('build/([^/]+)')).pop();
  if (package[domain].cache == null) {
    // Set cacheId to child dir
    let cachePath = path.join('cache', domain + '.json');
    package[domain].cache = fs.readJsonSync(cachePath, { throws: false }) || {};
    stream.setMaxListeners(50);
    stream.once('end', () => {
      let cacheStr = JSON.stringify(package[domain].cache, null, 2);
      fs.writeFileSync(cachePath, cacheStr);
    });
  }
  let relativeSourcePath = source.path.match(RegExp('build/?(.+)$')).pop();
  let hashNew = crypto
    .createHash('sha1')
    .update(source.contents)
    .digest('hex');
  if (hashNew !== package[domain].cache[relativeSourcePath]) {
    stream.push(source);
    package[domain].cache[relativeSourcePath] = hashNew;
  }
  return Promise.resolve();
};

exports.default = exports.build = build;
exports.deploy = deploy;
exports.disperse = gulp.series(build, deploy);
