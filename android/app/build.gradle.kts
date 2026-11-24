plugins {
    id("com.android.application")
}

android {
    namespace = "app.fitsup.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.fitsup.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "1.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Firmata con la chiave di debug: basta per installarla a mano (APK), non per il Play Store.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.core:core:1.13.1")
    implementation("androidx.webkit:webkit:1.12.1")
}
