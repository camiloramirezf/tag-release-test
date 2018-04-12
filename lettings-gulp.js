const { ok } = require('assert')
const gulp = require('gulp-help')(require('gulp'))
const ts = require('gulp-typescript')
const sourcemaps = require('gulp-sourcemaps')
const gulpif = require('gulp-if')
const tslint = require('gulp-tslint')
const mocha = require('gulp-spawn-mocha')
const bump = require('gulp-bump')
const gutil = require('gulp-util')
const zip = require('gulp-archiver')
const run = require('gulp-run')
const parseSlug = require('parse-github-repo-url')
const GitHubApi = require('@octokit/rest')
const gitRawCommits = require('git-raw-commits')
const concat = require('concat-stream')
const from = require('from2-array')
const conventionalCommitsParser = require('conventional-commits-parser')
const conventionalCommitsFilter = require('conventional-commits-filter')
const createReleaseChangelog = require('conventional-changelog-writer')
const del = require('del')
const merge = require('merge2')
const runSequence = require('run-sequence')
const replace = require('gulp-replace')
const rq = require('request-promise')
const moment = require('moment')
const { env } = require('process')
const fs = require('fs')
const path = require('path')
const semver = require('semver')

const tsProject = ts.createProject('tsconfig.json')
const outDir = tsProject.options.outDir
const deployDir = './dist'
const coverageDir = './coverage'

const SUPPORTED_ENV = {
  DEV: 'dev',
  TEST: 'test',
  STAGE: 'stage',
  PROD: 'prod'
}

const DeployConfig = {
  dev: {
    slot: 'akelius-lettingsapp-advert-api-dev',
    env: SUPPORTED_ENV.DEV,
    versionSuffix: '-dev',
    envSuffix: '-dev',
    username: env.AZUREDEPLOYCREDS_USR,
    password: env.AZUREDEPLOYCREDS_PSW
  },
  test: {
    slot: 'akelius-lettingsapp-advert-api-test',
    env: SUPPORTED_ENV.TEST,
    versionSuffix: '-beta',
    envSuffix: '-test',
    username: env.AZUREDEPLOYCREDS_USR,
    password: env.AZUREDEPLOYCREDS_PSW
  },
  stage: {
    slot: 'akelius-lettingsapp-advert-api-stage',
    env: SUPPORTED_ENV.STAGE,
    versionSuffix: '-rc',
    envSuffix: '-stage',
    username: env.AZUREDEPLOYCREDS_USR,
    password: env.AZUREDEPLOYCREDS_PSW
  },
  prod: {
    slot: 'akelius-lettingsapp-advert-api',
    env: SUPPORTED_ENV.PROD,
    versionSuffix: '',
    envSuffix: '',
    username: env.AZUREDEPLOYCREDS_USR,
    password: env.AZUREDEPLOYCREDS_PSW
  }
}

const TargetDeplomentConfig = getTargetDeploymentConfig()

gulp.task('clean', () => {
  return del([ coverageDir, outDir, deployDir ])
})

gulp.task('lint', () => {
  return gulp
    .src([ 'src/**/*.ts', '!src/**/generated*.ts' ])
    .pipe(tslint({ formatter: 'prose' }))
    .pipe(tslint.report({ allowWarnings: true }))
})

gulp.task('generateTypes', () => {
  return run('nswag run apispec.nswag /runtime:NetCore20').exec()
})

gulp.task('compile', () => {
  const IsProdBuild =
    TargetDeplomentConfig && TargetDeplomentConfig.env === SUPPORTED_ENV.PROD

  const tsResult = tsProject
    .src()
    .pipe(gulpif(!IsProdBuild, sourcemaps.init({ loadMaps: true })))
    .pipe(tsProject())

  return merge(
    tsResult.js.pipe(
      sourcemaps.write({
        // Return relative source map root directories per file.
        sourceRoot: function (file) {
          var sourceFile = path.join(file.cwd, file.sourceMap.file)
          return path.relative(path.dirname(sourceFile), file.cwd)
        }
      })
    ),
    tsResult.dts
  ).pipe(gulp.dest(outDir))
})

gulp.task('copyFiles', () => {
  const isLocalBuild = !TargetDeplomentConfig
  const envSuffix = TargetDeplomentConfig
    ? TargetDeplomentConfig.envSuffix
    : DeployConfig.dev.envSuffix

  const outDirStream = merge(
    gulp.src([ './host.json', './package.json', './local.settings.json' ]),
    gulp
      .src(`${tsProject.options.rootDir}/**/*-schema.json`)
      .pipe(replace('$ENV', envSuffix)),
    // as local builds need the function runtime verision 2, bindings need to be changed
    gulp
      .src(`${tsProject.options.rootDir}/**/function.json`)
      .pipe(replace('documentDB', isLocalBuild ? 'cosmosDB' : 'documentDB'))
  ).pipe(gulp.dest(outDir))

  const outDirBinStream = gulp
    .src('./bin/**/*')
    .pipe(gulp.dest(`${outDir}/bin`))

  return merge(outDirStream, outDirBinStream)
})

gulp.task('mocha', () => {
  return gulp
    .src('test/**/*.js', { read: false })
    .pipe(mocha({ istanbul: true }))
})

gulp.task('pack', () => {
  return run(`funcpack pack ${path.basename(outDir)}`).exec()
})

gulp.task('bump-version', async () => {
  const githubPassword = env.GITHUB_PSW
  ok(githubPassword, 'GITHUB_PSW is nil')

  const github = new GitHubApi()
  github.authenticate({
    type: 'oauth',
    token: githubPassword
  })

  const previousRelease = await getPreviousMatchingRelease(github)

  // use -dev version suffix for non-public branches
  const versionSuffix = TargetDeplomentConfig
    ? TargetDeplomentConfig.versionSuffix
    : DeployConfig.dev.versionSuffix

  if (!previousRelease) {
    gutil.log('No previous release found. Treating as first release.')

    return gulp
      .src('./package.json')
      .pipe(bump({ version: `1.0.0${versionSuffix}` }))
      .pipe(gulp.dest('./'))
  } else {
    gutil.log(`Previous release with version ${previousRelease.tagName} found.`)

    const commits = await parseCommitsSince(
      moment.utc(previousRelease.publishDate)
    )
    const bumpType = getBumpType(commits)

    const prevVersion = semver.parse(previousRelease.tagName)
    const prevVersionString = `${prevVersion.major}.${prevVersion.minor}.${prevVersion.patch}`
    const newVersionString =
      semver.inc(prevVersionString, bumpType) + versionSuffix

    return gulp
      .src('./package.json')
      .pipe(bump({ version: newVersionString, type: bumpType }))
      .pipe(gulp.dest('./'))
  }
})

gulp.task('zip', () => {
  return gulp
    .src([ `${outDir}/**/*`, `!${outDir}/local.settings.json` ], { dot: true })
    .pipe(zip('app.zip'))
    .pipe(gulp.dest(deployDir))
})

gulp.task('deploy:continuous', async () => {
  if (!TargetDeplomentConfig) {
    gutil.log(`No deployment config for branch ${env.BRANCH_NAME}, aborting.`)
    return
  }

  ok(TargetDeplomentConfig.username, 'AZUREDEPLOYCREDS_USR is nil')
  ok(TargetDeplomentConfig.password, 'AZUREDEPLOYCREDS_PSW is nil')

  gutil.log(`Deploying to ${TargetDeplomentConfig.slot}`)

  await rq.post(
    `https://${TargetDeplomentConfig.slot}.scm.azurewebsites.net/api/zipdeploy`,
    {
      auth: {
        username: TargetDeplomentConfig.username,
        password: TargetDeplomentConfig.password
      },
      body: fs.createReadStream(`${deployDir}/app.zip`)
    }
  )
})

gulp.task('release:github', async () => {
  if (!TargetDeplomentConfig) {
    gutil.log(`No deployment config for branch ${env.BRANCH_NAME}, aborting.`)
    return
  }

  if (TargetDeplomentConfig.env === SUPPORTED_ENV.DEV) {
    gutil.log(`Continuous release is not available for the 'dev' env.`)
    return
  }

  const githubPassword = env.GITHUB_PSW
  ok(githubPassword, 'GITHUB_PSW is nil')

  const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'))
  const ghRepo = parseSlug(pkg.repository.url)

  const github = new GitHubApi()
  github.authenticate({
    type: 'oauth',
    token: githubPassword
  })

  const previousRelease = await getPreviousMatchingRelease(github)
  const commits = await parseCommitsSince(
    previousRelease && moment.utc(previousRelease.publishDate)
  )

  const IsPrerelease =
    !TargetDeplomentConfig || TargetDeplomentConfig.env !== SUPPORTED_ENV.PROD

  return new Promise(async (resolve, reject) => {
    from
      .obj(commits)
      .pipe(createReleaseChangelog({ version: pkg.version }))
      .pipe(
        concat(async changelog => {
          const release = {
            owner: ghRepo[0],
            repo: ghRepo[1],
            name: pkg.version,
            tag_name: pkg.version,
            draft: false,
            prerelease: IsPrerelease,
            body: changelog
          }

          await github.repos.createRelease(release)

          gutil.log(
            `Created release ${release.name} on GitHub repo ${release.repo}`
          )
          resolve()
        })
      )
      .on('error', reject)
  })
})

gulp.task('build', done => {
  runSequence('clean', 'generateTypes', 'compile', 'copyFiles', done)
})

gulp.task('test', done => {
  runSequence('lint', 'build', 'mocha', done)
})

gulp.task('package', done => {
  runSequence('bump-version', 'test', 'pack', 'zip', done)
})

gulp.task('deploy', done => {
  runSequence('package', 'deploy:continuous', done)
})

gulp.task('release', done => {
  runSequence('deploy', 'release:github', done)
})

gulp.task('default', [ 'test' ])

// --- functions ---

function getTargetDeploymentConfig () {
  if (env.BRANCH_NAME === SUPPORTED_ENV.DEV) return DeployConfig.dev
  if (env.BRANCH_NAME === SUPPORTED_ENV.TEST) return DeployConfig.test
  if (/release_.+/.test(env.BRANCH_NAME)) return DeployConfig.stage
  if (
    env.AZURE_TARGETSLOT === SUPPORTED_ENV.PROD &&
    env.BRANCH_NAME === 'master'
  ) {
    return DeployConfig.prod
  }
}

function getBumpType (commits) {
  let versionBump = 'patch'
  for (const commit of commits) {
    if (commit.notes.length > 0) {
      versionBump = 'major'
    } else if (commit.type === 'feat') {
      if (versionBump === 'patch') {
        versionBump = 'minor'
      }
    }
  }

  return versionBump
}

async function getPreviousMatchingRelease (github) {
  // get latest release for dev-related branches because they don't have releases themselves.
  const lookupVersionSuffix =
    TargetDeplomentConfig && TargetDeplomentConfig.env !== SUPPORTED_ENV.DEV
      ? TargetDeplomentConfig.versionSuffix
      : DeployConfig.prod.versionSuffix

  async function getMatchingRelease (options) {
    function getReleaseSuffix (tag) {
      const prereleaseComponent = semver.prerelease(tag)

      const prefix = prereleaseComponent ? '-' : ''
      const suffix = (prereleaseComponent || [ '' ])[0]

      return `${prefix}${suffix}`
    }

    let response = await github.repos.getReleases(options)

    do {
      const matchingRelease = response.data.find(
        release => getReleaseSuffix(release.tag_name) === lookupVersionSuffix
      )

      if (matchingRelease) return matchingRelease

      response = github.hasNextPage(response)
        ? await github.getNextPage(response)
        : undefined
    } while (response)
  }

  async function getRelease (options, release) {
    const previousReleaseRefResponse = await github.gitdata.getReference({
      ...options,
      ref: `tags/${release.tag_name}`
    })

    if (!previousReleaseRefResponse.data) return

    return {
      id: release.id,
      url: previousReleaseRefResponse.data.url,
      tagName: release.tag_name,
      sha: previousReleaseRefResponse.data.object.sha,
      createDate: release.created_at,
      publishDate: release.published_at,
      isPrerelease: release.prerelease
    }
  }

  const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'))
  const ghRepo = parseSlug(pkg.repository.url)

  const options = {
    owner: ghRepo[0],
    repo: ghRepo[1]
  }

  const previousRelease = await getMatchingRelease({ ...options })
  if (!previousRelease) return

  return getRelease({ ...options }, previousRelease)
}

function parseCommitsSince (date) {
  return new Promise((resolve, reject) => {
    gitRawCommits({
      format: '%B%n-hash-%n%H%n-gitTags-%n%d%n-committerDate-%n%aI'
    })
      .pipe(
        conventionalCommitsParser({
          revertPattern: /^revert:\s([\s\S]*?)\s*This reverts commit (\w*)\./
        })
      )
      .pipe(
        concat(parsedCommits => {
          const filteredCommits = conventionalCommitsFilter(parsedCommits)

          const commitsSinceLastRelease = date
            ? filteredCommits.filter(c => moment(c.committerDate).isAfter(date))
            : filteredCommits

          resolve(commitsSinceLastRelease)
        })
      )
      .on('error', reject)
  })
}