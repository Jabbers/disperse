## Disperse

Builds websites from source and deploys them online.

## Usage

```
gulp [build,deploy] [--site=domain.com] [--filter=regex]
```

### build, deploy

Type: `String` Default: `build`

Specify task(s) to perform on site(s).

`build` generates site files from `src/sites/` into `build/`.

- [Handlebars](http://handlebarsjs.com) files (`.hbs`) are compiled with src/layouts and src/partials.
- Javascript and CSS files are minimized and merged into app.min.js and app.min.css.

`deploy` uploads site files from `build/` to their remote location in `config.yaml`.

### --site

Type: `String` Default: sites with `active: true` in `config.yaml`

Specify site by domain.

### --filter

Type: `Glob` Default: `undefined`

Filter site files by glob. See [node-glob](https://github.com/isaacs/node-glob) for the glob syntax.

## Configuration

### Site settings `config.yaml`


- active: true|false
- hosting: domain.com
- panel: [url]
- protocol: ftp|sftp
- host
- port
- user
- pass
- remotePath


## Author

- Fred Steegmans (u/jabman)