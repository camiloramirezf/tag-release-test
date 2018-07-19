pipeline {
    agent{
        label 'CommonLogic'
    }
    parameters {
        string(name: 'AZURE_TARGETSLOT', defaultValue: 'dev', description: 'Target deployment slot( prod, test, dev)')
    }
    options {
        timeout(time: 10, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '5'))
        durabilityHint('PERFORMANCE_OPTIMIZED')
        disableConcurrentBuilds()
        timestamps()
    }
    stages {
        stage ('Checkout') {
            steps {
                checkout scm
            }
        }
        
        stage('Release') {
            environment {
                GITHUB_PSW = credentials('9524f93b89e9115e271cfb89cea51ee43b39a51f')                
                AZUREDEVCREDS = credentials("dictionary_dev_credentials")                               
            }
            steps {
                bat 'build.cmd release'
            }
        }
    }
}