const gulp = require('gulp-help')(require('gulp'));
const localenv = require('gulp-env');

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
        slot: 'akelius-lettingsapp-advert-api',
        env: SUPPORTED_ENV.PROD,
        versionSuffix: '',
        envSuffix: '',
        username: env.AZUREDEPLOYCREDS_USR,
        password: env.AZUREDEPLOYCREDS_PSW
    }
}

gulp.task('set-env', () => {
    localenv({
        vars: {
            CURRENT_ENV: "dev"
        }
    })
})

gulp.task('bump-version', ['set-env'], async () => {

    // TODO: check the current environment
    const config = DeployConfig[process.env.CURRENT_ENV];
    console.log(config);    

});