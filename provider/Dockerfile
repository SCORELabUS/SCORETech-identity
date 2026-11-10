FROM maven:3.9.11-eclipse-temurin-21 AS java
WORKDIR /build
COPY provider/providers/email-otp/pom.xml ./pom.xml
RUN mvn --batch-mode --no-transfer-progress dependency:go-offline
COPY provider/providers/email-otp/src ./src
COPY provider/themes /themes
RUN mvn --batch-mode --no-transfer-progress package
FROM quay.io/keycloak/keycloak:26.7.1 AS optimized
ARG IDENTITY_PROVIDER_PATH=/identity/auth
COPY provider/themes /opt/keycloak/themes
COPY --from=java /build/target/tentu-email-otp-provider.jar /opt/keycloak/providers/
RUN /opt/keycloak/bin/kc.sh build --db=postgres --http-relative-path=${IDENTITY_PROVIDER_PATH} --http-management-relative-path=/ --features=passkeys --health-enabled=true --metrics-enabled=true --spi-email-sender--provider-default=score-brevo
FROM quay.io/keycloak/keycloak:26.7.1 AS provider
COPY --from=optimized /opt/keycloak/ /opt/keycloak/
COPY --chmod=0755 provider/entrypoint.sh /opt/keycloak/bin/score-entrypoint.sh
USER 1000
ENTRYPOINT ["/opt/keycloak/bin/score-entrypoint.sh"]
