const gulp = require("gulp-help")(require("gulp"));
const parseSlug = require("parse-github-repo-url");
const GitHubApi = require("@octokit/rest");
const gutil = require("gulp-util");
const localenv = require("gulp-env");
const bump = require("gulp-bump");
const fs = require("fs");
const semver = require("semver");
const moment = require("moment");
const gitRawCommits = require("git-raw-commits");
const concat = require("concat-stream");
const conventionalCommitsParser = require("conventional-commits-parser");
const conventionalCommitsFilter = require("conventional-commits-filter");
const createReleaseChangelog = require("conventional-changelog-writer");
const { env } = require("process");

const SUPPORTED_ENV = {
  TEMP: "temp",
  DEV: "dev",
  TEST: "test",
  STAGE: "stage",
  PROD: "prod"
};

const DeployConfig = {
  temp: {
    slot: "azure temp slot",
    env: "temp",
    versionSuffix: "-temp",
    envSuffix: "-temp",
    username: "",
    password: ""
  },
  dev: {
    slot: "azure dev slot",
    env: "dev",
    versionSuffix: "-dev",
    envSuffix: "-dev",
    username: "",
    password: ""
  },
  test: {
    slot: "azure test slot",
    env: "test",
    versionSuffix: "-test",
    envSuffix: "-test",
    username: "",
    password: ""
  },
  prod: {
    slot: "azure production slot",
    env: "test",
    versionSuffix: "",
    envSuffix: "",
    username: "",
    password: ""
  }
};

const TargetDeploymentConfig = getDeploymentConfig();

gulp.task("set-env", () => {
  localenv({
    vars: {
      CURRENT_ENV: "dev",
      GITHUB_PSW: "9366bd0d61a1f7cee96f715c37a2926c77aae491"
    }
  });
});

gulp.task("bump-version", [""], async done => {
  const githubPass = process.env.GITHUB_PSW;
  const github = new GitHubApi();
  github.authenticate({
    type: "oauth",
    token: githubPass
  });

  const previousRelease = await getPreviousMatchingRelease(github);

  // use -dev version suffix.
  const versionSuffix = TargetDeplomentConfig
    ? TargetDeplomentConfig.versionSuffix
    : DeployConfig.dev.versionSuffix;

  if (!previousRelease) {
    gutil.log("no previous relese, create first");
    return gulp
      .src("./package.json")
      .pipe(bump({ version: `0.1.0` }))
      .pipe(gulp.dest("./"));
  } else {
    gutil.log(
      `Previous release with version ${previousRelease.tagName} found.`
    );

    const commits = await parseCommitsSince(
      moment.utc(previousRelease.publishDate)
    );

    const bumpType = getBumpType(commits);
    const prevVersion = semver.parse(previousRelease.tagName);
    const prevVersionString = `${prevVersion.major}.${prevVersion.minor}.${
      prevVersion.patch
    }`;
    const newVersionString =
      semver.inc(prevVersionString, bumpType) + versionSuffix;
    gutil.log(prevVersionString);
    gutil.log(newVersionString);
    return gulp
      .src("./package.json")
      .pipe(bump({ version: newVersionString, type: bumpType }))
      .pipe(gulp.dest("./"));
  }
});

gulp.task("semver-test", async done => {
  const bumpType = "patch";
  const tagName = "rc-2018.07.19";
  const versionSuffix = "-beta";

  const prevVersion = semver.parse(tagName);
  const prereleaseComponent = semver.prerelease(tagName);
  const prevVersionString = `${prevVersion.major}.${prevVersion.minor}.${
    prevVersion.patch
  }`;

  const newVersionString =
    semver.inc(prevVersionString, bumpType) + versionSuffix;
  gutil.log(prevVersionString);
  gutil.log(newVersionString);
});

gulp.task("post-zip", async done => {
  const targetConfig = getDeploymentConfig();
  gutil.log(targetConfig);
  gutil.log(`deploying to ${targetConfig.env}`);
});

gulp.task("print-tags", async done => {
  // auth in github
  const githubPass = process.env.GITHUB_PSW;
  const github = new GitHubApi();
  github.authenticate({
    type: "oauth",
    token: githubPass
  });

  // read repo url from package.json
  const pkg = JSON.parse(fs.readFileSync("./package.json", "utf8"));
  const ghRepo = parseSlug(pkg.repository.url);

  const options = {
    owner: ghRepo[0],
    repo: ghRepo[1]
  };

  let response = await github.repos.getReleases(options);

  // Get releases after the one with the same sufix (e.g beta, rc, '')
  // matches with the current suffix (depends on the environment);
  let allReleases = [];
  do {
    const lookupVersionSuffix = "";
    const matchingRelease = response.data.find(
      release => getReleaseSuffix(release.tag_name) === lookupVersionSuffix
    );

    if (response) allReleases.push(response);

    response = github.hasNextPage(response)
      ? await github.getNextPage(response)
      : undefined;
  } while (response);

  console.log(allReleases);

  // conditions
  // 1. if no new rc found, deploy to dev env
  // 2. if new rc found, deploy to test env
  // 3. if new release found, deploy to staging
  // 4. only if flag detected (set manually in jenkins) deploy to prod.
});

gulp.task("release:github", async () => {
  const currentConfig = getTargetDeploymentConfig();

  if (!currentConfig) {
    gutil.log(
      `No deployment config for env ${process.env.BRANCH_NAME}, aborting.`
    );
    return;
  }

  if (currentConfig.env === "dev" || currentConfig.env === "temp") {
    gutil.log(
      `Continuous release is not available for the 'dev' and 'temp' env.`
    );
    return;
  }

  const githubPassword = process.env.GITHUB_PSW;
  //ok(githubPassword, 'GITHUB_PSW is null');

  const pkg = JSON.parse(fs.readFileSync("./package.json", "utf8"));
  const ghRepo = parseSlug(pkg.repository.url);

  const github = new GitHubApi();
  github.authenticate({
    type: "oauth",
    token: githubPassword
  });

  const previousRelease = await getPreviousMatchingRelease(github);
  const commits = await parseCommitsSince(
    previousRelease && moment.utc(previousRelease.publishDate)
  );

  const IsPrerelease = !DeployConfig || currentConfig.envSuffix !== "";

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
          };

          await github.repos.createRelease(release);

          gutil.log(
            `Created release ${release.name} on GitHub repo ${release.repo}`
          );
          resolve();
        })
      )
      .on("error", reject);
  });
});

gulp.task("release", done => {
  runSequence("bump-version", "post-zip", "release:github");
});

function getReleaseSuffix(tag) {
  const prereleaseComponent = semver.prerelease(tag);
  const prefix = prereleaseComponent ? "-" : "";
  const suffix = (prereleaseComponent || [""])[0];

  return `${prefix}${suffix}`;
}

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

async function getPreviousMatchingRelease(github) {
  // get latest release for dev-related branches because they don't have releases themselves.
  const lookupVersionSuffix =
    TargetDeploymentConfig && TargetDeplomentyConfig.env !== SUPPORTED_ENV.DEV
      ? TargetDeploymentConfig.versionSuffix
      : DeployConfig.prod.versionSuffix;

  async function getMatchingRelease(options) {
    function getReleaseSuffix(tag) {
      const prereleaseComponent = semver.prerelease(tag);
      const prefix = prereleaseComponent ? "-" : "";
      const suffix = (prereleaseComponent || [""])[0];

      return `${prefix}${suffix}`;
    }

    let response = await github.repos.getReleases(options);

    // Get releases after the one with the same sufix (e.g beta, rc, '')
    // matches with the current suffix (depends on the environment);
    do {
      const matchingRelease = response.data.find(
        release => getReleaseSuffix(release.tag_name) === lookupVersionSuffix
      );

      if (matchingRelease) return matchingRelease;

      response = github.hasNextPage(response)
        ? await github.getNextPage(response)
        : undefined;
    } while (response);
  }

  async function getRelease(options, release) {
    const opts = options;
    opts.ref = `tags/${release.tag_name}`;
    const previousReleaseRefResponse = await github.gitdata.getReference(
      options
    );

    if (!previousReleaseRefResponse.data) return;

    return {
      id: release.id,
      url: previousReleaseRefResponse.data.url,
      tagName: release.tag_name,
      sha: previousReleaseRefResponse.data.object.sha,
      createDate: release.created_at,
      publishDate: release.published_at,
      isPrerelease: release.prerelease
    };
  }

  const pkg = JSON.parse(fs.readFileSync("./package.json", "utf8"));
  const ghRepo = parseSlug(pkg.repository.url);

  const options = {
    owner: ghRepo[0],
    repo: ghRepo[1]
  };

  const previousRelease = await getMatchingRelease(options);
  if (!previousRelease) return;

  return getRelease({ ...options }, previousRelease);
}

function getBumpType(commits) {
  let versionBump = "patch";
  for (const commit of commits) {
    if (commit.notes.length > 0) {
      versionBump = "major";
    } else if (commit.type === "feat") {
      if (versionBump === "patch") {
        versionBump = "minor";
      }
    }
  }

  return versionBump;
}

function parseCommitsSince(date) {
  return new Promise((resolve, reject) => {
    gitRawCommits({
      format: "%B%n-hash-%n%H%n-gitTags-%n%d%n-committerDate-%n%aI"
    })
      .pipe(
        conventionalCommitsParser({
          revertPattern: /^revert:\s([\s\S]*?)\s*This reverts commit (\w*)\./
        })
      )
      .pipe(
        concat(parsedCommits => {
          const filteredCommits = conventionalCommitsFilter(parsedCommits);

          const commitsSinceLastRelease = date
            ? filteredCommits.filter(c => moment(c.committerDate).isAfter(date))
            : filteredCommits;

          resolve(commitsSinceLastRelease);
        })
      )
      .on("error", reject);
  });
}

function getDeploymentConfig() {
  let targetEnv = null;

  if (/rc+/.test(env.TAG_NAME)) targetEnv = DeployConfig.test;
  else if (/release+/.test(env.TAG_NAME)) targetEnv = DeployConfig.staging;
  else if (
    env.AZURE_TARGETSLOT == SUPPORTED_ENV.PROD &&
    env.BRANCH_NAME === "master"
  )
    targetEnv = DeployConfig.prod;
  else if (env.BRANCH_NAME === "master") targetEnv = DeployConfig.dev;
  else targetEnv = DeployConfig.temp;

  return targetEnv;
}
