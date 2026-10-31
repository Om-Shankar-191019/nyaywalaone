#include <stdio.h>
#include <stdlib.h>

int main(void) {
    int a = 0, b = 0;
    if (scanf("%d %d", &a, &b) != 2) {
        return 1;
    }
    int *buffer = malloc(16 * sizeof(int));
    if (buffer == NULL) {
        return 1;
    }
    buffer[0] = a;
    buffer[1] = b;
    printf("%d\n", buffer[0] + buffer[1]);
    return 0;
}
