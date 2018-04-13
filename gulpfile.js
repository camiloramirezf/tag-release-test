const gulp = require('gulp-help')(require('gulp'));
const parseSlug = require('parse-github-repo-url');
const GitHubApi = require('@octokit/rest');
const localenv = require('gulp-env');
const bump = require('gulp-bump');
const fs = require('fs');
const semver = require('semver');
const conventionalCommitsParser = require('conventional-commits-parser');
const conventionalCommitsFilter = require('conventional-commits-filter');
const createReleaseChangelog = require('conventional-changelog-writer');

const DeployConfig = {
    dev: {
        slot: "",
        env: "dev",
        versionSuffix: '-dev',
        envSuffix: '-dev',
        username: "",
        password: ""
    },
    test: {
        slot: "",
        env: "test",
        versionSuffix: '-test',
        envSuffix: '-test',
        username: "",
        password: ""
    },
    prod: {
        slot: "",
        env: "test",
        versionSuffix: '',
        envSuffix: '',
        username: "",
        password: ""
    }
}

gulp.task('set-env', () => {
    localenv({
        vars: {
            CURRENT_ENV: "dev",
            GITHUB_PSW: "bd799c3cf2d752cbbdd91f55c0db4b8db81bf902"
        }
    })
})

gulp.task('bump-version', ['set-env'], async (done) => {    
    
    const currentConfig = DeployConfig[process.env.CURRENT_ENV];
    const githubPass = process.env.GITHUB_PSW;
    const github = new GitHubApi();
    github.authenticate({
        type: "oauth",
        token: githubPass
    });

    const previousRelease = await getPreviousMatchingRelease(github);    
    const versionSuffix = DeployConfig ? currentConfig.versionSuffix : DeployConfig.dev.versionSuffix;

    if(!previousRelease) {
        console.log("no previous relese, create first");
        return gulp
            .src('./package.json')
            .pipe(bump({ version: `0.1.0` }))
            .pipe(gulp.dest('./'))

    } else {
        gutil.log(`Previous release with version ${previousRelease.tagName} found.`);

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
            .pipe(gulp.dest('./'));
    }
});

/*
Returns a release
Example of a release  
{ id: 10530012,
  url: 'https://api.github.com/repos/camiloramirezf/tag-release-test/git/refs/tags/0.1.0',
  tagName: '0.1.0',
  sha: '8f2c3bbd8a4d612c4d4d6d89d770b9fcd08595cb',
  createDate: '2018-04-12T14:35:41Z',
  publishDate: '2018-04-13T07:49:47Z',
  isPrerelease: false }
*/

async function getPreviousMatchingRelease (github) {

    // get latest release for dev-related branches because they don't have releases themselves.      
    const lookupVersionSuffix =
    TargetDeployConfig && TargetDeployConfig.env !== 'dev'
      ? TargetDeployConfig.versionSuffix
      : DeployConfig.prod.versionSuffix
    
    async function getMatchingRelease (options) {
      function getReleaseSuffix (tag) {
        const prereleaseComponent = semver.prerelease(tag)        
        const prefix = prereleaseComponent ? '-' : ''
        const suffix = (prereleaseComponent || [ '' ])[0]
  
        return `${prefix}${suffix}`
      }
  
      let response = await github.repos.getReleases(options);    

      // Get releases after the one with the same sufix (e.g beta, rc, '') 
      // matches with the current suffix (depends on the environment);  
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
      const opts = options;
      opts.ref = `tags/${release.tag_name}`;
      const previousReleaseRefResponse = await github.gitdata.getReference(options);
  
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

    const previousRelease = await getMatchingRelease(options);
    if (!previousRelease) return
  
    return getRelease({ ...options }, previousRelease);    
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